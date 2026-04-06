const API_BASE = '/api';

interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

interface Settings {
  domains: string[];
  announcement: string;
  enable_address_password: boolean;
  disable_custom_address_name: boolean;
  always_show_announcement: boolean;
  prefix: string;
}

interface Mail {
  id: number;
  source: string | null;
  address: string;
  subject: string | null;
  sender: string | null;
  message_id: string | null;
  created_at: string;
  is_read: number;
  metadata: string | null;
  text?: string | null;
  html?: string | null;
  attachments?: Attachment[];
}

interface Attachment {
  id: number;
  filename: string | null;
  size: number | null;
  content_type: string | null;
  content_id: string | null;
  is_inline: number;
}

interface CreateAddressResponse {
  id: number;
  address: string;
  token: string;
}

interface MailsResponse {
  mails: Mail[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
  address: string;
  needs_password: boolean;
}

// Store token in localStorage
const TOKEN_KEY = 'temp_mail_token';
const ADDRESS_KEY = 'temp_mail_address';

export function saveToken(token: string, address: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(ADDRESS_KEY, address);
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getAddress(): string | null {
  return localStorage.getItem(ADDRESS_KEY);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ADDRESS_KEY);
}

// API helper function
async function api<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const token = getToken();
  
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (token) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  const data = await response.json();
  return data;
}

// API endpoints
export const apiClient = {
  // Get public settings
  async getSettings(): Promise<ApiResponse<Settings>> {
    return api<Settings>('/settings');
  },

  // Create new address
  async createAddress(
    name?: string,
    password?: string,
    domain?: string
  ): Promise<ApiResponse<CreateAddressResponse>> {
    const body: Record<string, string> = {};
    if (name) body.name = name;
    if (password) body.password = password;
    if (domain) body.domain = domain;

    return api<CreateAddressResponse>('/new_address', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  // Get mails
  async getMails(page: number = 1, limit: number = 20): Promise<ApiResponse<MailsResponse>> {
    return api<MailsResponse>(`/mails?page=${page}&limit=${limit}`);
  },

  // Get mail detail
  async getMail(id: number): Promise<ApiResponse<Mail>> {
    return api<Mail>(`/mails/${id}`);
  },

  // Delete mail
  async deleteMail(id: number): Promise<ApiResponse<{ deleted: number }>> {
    return api<{ deleted: number }>(`/mails/${id}`, {
      method: 'DELETE',
    });
  },

  // Health check
  async health(): Promise<ApiResponse<{ status: string }>> {
    return api<{ status: string }>('/health');
  },
};

export type { Settings, Mail, Attachment, CreateAddressResponse, MailsResponse };
