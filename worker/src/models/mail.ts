export interface Mail {
  id: number;
  source: string | null;
  address: string;
  raw: string | null;
  subject: string | null;
  sender: string | null;
  message_id: string | null;
  created_at: string;
  is_read: number;
  metadata: string | null;
}

export interface MailWithParsed extends Mail {
  text?: string | null;
  html?: string | null;
  attachments?: AttachmentMeta[];
  has_attachment?: boolean;
}

export interface AttachmentMeta {
  id: number;
  mail_id: number;
  filename: string | null;
  storage_key: string | null;
  size: number | null;
  content_type: string | null;
  content_id: string | null;
  is_inline: number;
}

export interface Attachment {
  filename: string | null;
  content_type: string;
  content_id: string | null;
  content: string | null; // Base64 encoded
  size: number;
  is_inline: boolean;
}

export interface ParsedMail {
  subject: string | null;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  reply_to: EmailAddress[];
  text: string | null;
  html: string | null;
  attachments: Attachment[];
  message_id: string | null;
  date: string | null;
  headers: [string, string][];
  has_attachment: boolean;
}

export interface EmailAddress {
  name: string | null;
  address: string;
}
