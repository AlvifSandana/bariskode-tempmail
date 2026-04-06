use mail_parser::*;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// Represents an email address with name and address
#[derive(Serialize, Deserialize)]
pub struct EmailAddress {
    pub name: Option<String>,
    pub address: String,
}

/// Represents an email attachment
#[derive(Serialize, Deserialize)]
pub struct Attachment {
    pub filename: Option<String>,
    pub content_type: String,
    pub content_id: Option<String>,
    pub content: Option<String>,  // Base64 encoded
    pub size: usize,
    pub is_inline: bool,
}

/// Parsed email result
#[derive(Serialize, Deserialize)]
pub struct ParsedMail {
    pub subject: Option<String>,
    pub from: Vec<EmailAddress>,
    pub to: Vec<EmailAddress>,
    pub cc: Vec<EmailAddress>,
    pub reply_to: Vec<EmailAddress>,
    pub text: Option<String>,
    pub html: Option<String>,
    pub attachments: Vec<Attachment>,
    pub message_id: Option<String>,
    pub date: Option<String>,
    pub headers: Vec<(String, String)>,
    pub has_attachment: bool,
}

impl EmailAddress {
    fn from_addr(addr: &Addr) -> EmailAddress {
        EmailAddress {
            name: addr.name().map(|s| s.to_string()),
            address: addr.address().unwrap_or("").to_string(),
        }
    }
}

/// Parse raw email bytes into structured format
#[wasm_bindgen]
pub fn parse_mail(raw: &[u8]) -> Result<JsValue, JsValue> {
    let message = MessageParser::default()
        .parse(raw)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse email: {:?}", e)))?;

    // Extract subject
    let subject = message.subject().map(|s| s.to_string());

    // Extract from addresses
    let from = message
        .from()
        .map(|addrs| addrs.iter().map(EmailAddress::from_addr).collect())
        .unwrap_or_default();

    // Extract to addresses
    let to = message
        .to()
        .map(|addrs| addrs.iter().map(EmailAddress::from_addr).collect())
        .unwrap_or_default();

    // Extract cc addresses
    let cc = message
        .cc()
        .map(|addrs| addrs.iter().map(EmailAddress::from_addr).collect())
        .unwrap_or_default();

    // Extract reply-to addresses
    let reply_to = message
        .reply_to()
        .map(|addrs| addrs.iter().map(EmailAddress::from_addr).collect())
        .unwrap_or_default();

    // Extract text body
    let text = message.text_body().map(|part| {
        let text = part.text_contents().unwrap_or_default();
        text.to_string()
    });

    // Extract HTML body
    let html = message.html_body().map(|part| {
        let text = part.text_contents().unwrap_or_default();
        text.to_string()
    });

    // Extract message-id
    let message_id = message.message_id().map(|s| s.to_string());

    // Extract date
    let date = message.date().map(|d| d.to_string());

    // Extract headers
    let headers: Vec<(String, String)> = message
        .headers()
        .iter()
        .map(|header| {
            let name = header.name().to_string();
            let value = header.value().to_string();
            (name, value)
        })
        .collect();

    // Extract attachments
    let mut attachments: Vec<Attachment> = Vec::new();
    let mut has_attachment = false;

    // Process all body parts for attachments
    for part in message.body_parts() {
        process_attachments(part, &mut attachments, &mut has_attachment);
    }

    let parsed = ParsedMail {
        subject,
        from,
        to,
        cc,
        reply_to,
        text,
        html,
        attachments,
        message_id,
        date,
        headers,
        has_attachment,
    };

    // Serialize to JSON
    let json = serde_json::to_string(&parsed)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize: {:?}", e)))?;

    Ok(JsValue::from_str(&json))
}

/// Recursively process body parts for attachments
fn process_attachments(part: &Part, attachments: &mut Vec<Attachment>, has_attachment: &mut bool) {
    // Check if this part is an attachment
    if let Some(content_type) = part.content_type() {
        let ctype = content_type.type_().to_string();
        let subtype = content_type.subtype().map(|s| s.to_string()).unwrap_or_default();
        let full_type = format!("{}/{}", ctype, subtype);

        let content_disposition = part.content_disposition();
        let is_inline = content_disposition.map_or(true, |d| d == "inline");

        // Skip text/html and text/plain (these are body content, not attachments)
        // unless they have a filename
        let filename = part.attachment_name().map(|s| s.to_string());

        let is_body_content = (ctype == "text" && (subtype == "plain" || subtype == "html"))
            && filename.is_none();

        if !is_body_content && (ctype != "multipart" || filename.is_some()) {
            // Extract content
            let content = part.contents();
            if let Some(content_bytes) = content {
                *has_attachment = true;

                // Get content-id for inline images
                let content_id = part.content_id().map(|s| s.to_string());

                // Base64 encode the content
                let content_b64 = base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    content_bytes,
                );

                attachments.push(Attachment {
                    filename,
                    content_type: full_type,
                    content_id,
                    content: Some(content_b64),
                    size: content_bytes.len(),
                    is_inline,
                });
            }
        }
    }

    // Recursively process sub-parts
    if let Some(sub_parts) = part.sub_parts() {
        for sub_part in sub_parts {
            process_attachments(sub_part, attachments, has_attachment);
        }
    }
}

/// Get email preview text (first N characters of text body)
#[wasm_bindgen]
pub fn get_preview(raw: &[u8], max_length: usize) -> Result<JsValue, JsValue> {
    let message = MessageParser::default()
        .parse(raw)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse email: {:?}", e)))?;

    let text = message
        .text_body()
        .and_then(|part| part.text_contents())
        .map(|s| s.to_string())
        .unwrap_or_default();

    let preview = if text.len() > max_length {
        format!("{}...", &text[..max_length])
    } else {
        text
    };

    Ok(JsValue::from_str(&preview))
}

/// Check if email has attachments
#[wasm_bindgen]
pub fn has_attachments(raw: &[u8]) -> Result<bool, JsValue> {
    let message = MessageParser::default()
        .parse(raw)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse email: {:?}", e)))?;

    for part in message.body_parts() {
        if check_has_attachments(part) {
            return Ok(true);
        }
    }

    Ok(false)
}

/// Recursively check for attachments
fn check_has_attachments(part: &Part) -> bool {
    if let Some(content_type) = part.content_type() {
        let ctype = content_type.type_().to_string();
        let filename = part.attachment_name();

        // Check if this is an actual attachment (not body content)
        if ctype != "multipart" && ctype != "text" && filename.is_some() {
            return true;
        }
    }

    // Check sub-parts
    if let Some(sub_parts) = part.sub_parts() {
        for sub_part in sub_parts {
            if check_has_attachments(sub_part) {
                return true;
            }
        }
    }

    false
}

/// Initialize WASM (for panic hook)
#[wasm_bindgen]
pub fn init() {
    console_error_panic_hook::set_once();
}

// Add console_error_panic_hook for better error messages
mod console_error_panic_hook {
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = console)]
        fn error(msg: String);
    }

    pub fn set_once() {
        std::panic::set_hook(Box::new(|info| {
            error(info.to_string());
        }));
    }
}
