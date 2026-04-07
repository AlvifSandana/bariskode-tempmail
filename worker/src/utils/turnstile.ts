type TurnstileSiteverifyResponse = {
  success?: boolean;
  'error-codes'?: string[];
};

function isValidIpv4(value: string): boolean {
  const ipv4Part = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
  const ipv4 = new RegExp(`^${ipv4Part}(\\.${ipv4Part}){3}$`);
  return ipv4.test(value);
}

function isLikelyIpv6(value: string): boolean {
  return value.includes(':') && /^[0-9a-fA-F:]+$/.test(value);
}

function normalizeRemoteIp(value: string | undefined): string | undefined {
  const ip = String(value || '').trim();
  if (!ip || ip === 'unknown') return undefined;
  if (isValidIpv4(ip) || isLikelyIpv6(ip)) return ip;
  return undefined;
}

export function extractTurnstileToken(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const candidate = body as Record<string, unknown>;
  const keys = ['turnstile_token', 'captcha_token', 'cf_turnstile_response', 'cf-turnstile-response'];
  for (const key of keys) {
    const value = candidate[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return '';
}

export async function verifyTurnstileToken(params: {
  secret: string;
  token: string;
  remoteIp?: string;
}): Promise<{ success: boolean; errorCodes: string[] }> {
  const form = new URLSearchParams();
  form.set('secret', params.secret);
  form.set('response', params.token);
  const remoteIp = normalizeRemoteIp(params.remoteIp);
  if (remoteIp) form.set('remoteip', remoteIp);

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });

    const json = (await response.json().catch(() => ({}))) as TurnstileSiteverifyResponse;
    return {
      success: Boolean(response.ok && json.success),
      errorCodes: Array.isArray(json['error-codes']) ? json['error-codes'] : [],
    };
  } catch {
    return {
      success: false,
      errorCodes: ['turnstile_unreachable'],
    };
  }
}
