const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) || '/api';
const AUTH_BASE = (import.meta.env.VITE_AUTH_BASE as string | undefined) || '';

interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

interface AuthUser {
  id: number;
  user_email: string | null;
  roles: string[];
}

interface AuthResponse {
  token: string;
  user: AuthUser;
}

interface OAuthProvider {
  name: string;
  auth_url: string;
}

interface OAuthStartResponse {
  provider: string;
  state: string;
  auth_url: string;
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
  storage_key?: string | null;
  size: number | null;
  content_type: string | null;
  content_id: string | null;
  is_inline: number;
}

interface SendboxMail {
  id: number;
  address: string;
  subject: string | null;
  sender: string | null;
  recipient: string;
  created_at: string;
}

interface SendboxResponse {
  sendbox: SendboxMail[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}

interface AdminStats {
  addresses: number;
  users: number;
  mails: number;
  sent_mails: number;
}

interface AdminAddressRow {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
  source_ip: string | null;
  mail_count: number;
  user_id: number | null;
}

interface AdminAddressListResponse {
  addresses: AdminAddressRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}

interface AdminUserRow {
  id: number;
  user_email: string | null;
  created_at: string;
  updated_at: string;
  address_count: number;
}

interface AdminUserListResponse {
  users: AdminUserRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}

interface AdminSettingsRow {
  key: string;
  value: string;
}

interface AdminSettingsResponse {
  settings: AdminSettingsRow[];
}

interface AdminDbInitResponse {
  mode: string;
  initialized: boolean;
  message: string;
  required_tables: string[];
  missing_core_tables: string[];
  migration_hint_commands: string[];
  next_action: string;
}

interface UserProfile {
  id: number;
  user_email: string | null;
  created_at: string;
  updated_at: string;
  roles: string[];
}

interface UserAddressesResponse {
  addresses: Array<{
    id: number;
    name: string;
    created_at: string;
    bound_at: string;
  }>;
}

interface UserMailsResponse {
  mails: Mail[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
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

// Store tokens in localStorage
const ADDRESS_TOKEN_KEY = 'temp_mail_token';
const ADDRESS_KEY = 'temp_mail_address';
const USER_EMAIL_KEY = 'temp_mail_user_email';
const USER_CSRF_COOKIE = 'tm_user_csrf';

function getCookie(name: string): string {
  if (typeof document === 'undefined') return '';
  const encodedName = `${encodeURIComponent(name)}=`;
  const parts = document.cookie.split(';');
  for (const raw of parts) {
    const part = raw.trim();
    if (part.startsWith(encodedName)) {
      const value = part.slice(encodedName.length);
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return '';
}

export function saveToken(token: string, address: string): void {
  localStorage.setItem(ADDRESS_TOKEN_KEY, token);
  localStorage.setItem(ADDRESS_KEY, address);
}

export function getToken(): string | null {
  return localStorage.getItem(ADDRESS_TOKEN_KEY);
}

export function getAddress(): string | null {
  return localStorage.getItem(ADDRESS_KEY);
}

export function clearToken(): void {
  localStorage.removeItem(ADDRESS_TOKEN_KEY);
  localStorage.removeItem(ADDRESS_KEY);
}

export function saveUserToken(token: string, email?: string | null): void {
  void token;
  if (email) {
    localStorage.setItem(USER_EMAIL_KEY, email);
  } else {
    localStorage.removeItem(USER_EMAIL_KEY);
  }
}

export function getUserToken(): string | null {
  return null;
}

export function getUserEmail(): string | null {
  return localStorage.getItem(USER_EMAIL_KEY);
}

export function clearUserToken(): void {
  localStorage.removeItem(USER_EMAIL_KEY);
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

async function authApi<T>(endpoint: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
  const method = String(options.method || 'GET').toUpperCase();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers || {}) as Record<string, string>),
  };

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const csrfToken = getCookie(USER_CSRF_COOKIE);
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }
  }

  const response = await fetch(`${AUTH_BASE}${endpoint}`, {
    ...options,
    credentials: 'include',
    headers,
  });
  return response.json();
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

  async addressAuth(address: string, password: string): Promise<ApiResponse<CreateAddressResponse>> {
    return api<CreateAddressResponse>('/address_auth', {
      method: 'POST',
      body: JSON.stringify({ address, password }),
    });
  },

  async getSendbox(page: number = 1, limit: number = 20): Promise<ApiResponse<SendboxResponse>> {
    return api<SendboxResponse>(`/sendbox?page=${page}&limit=${limit}`);
  },

  async deleteSendbox(id: number): Promise<ApiResponse<{ deleted: number }>> {
    return api<{ deleted: number }>(`/sendbox/${id}`, {
      method: 'DELETE',
    });
  },

  getAttachmentDownloadUrl(mailId: number, attachmentId: number): string {
    return `${API_BASE}/mails/${mailId}/attachment/${attachmentId}`;
  },

  async register(email: string, password: string): Promise<ApiResponse<AuthResponse>> {
    return authApi<AuthResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },

  async login(email: string, password: string): Promise<ApiResponse<AuthResponse>> {
    return authApi<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },

  async refreshUserToken(): Promise<ApiResponse<{ token: string; refreshed: boolean; user: AuthUser }>> {
    return authApi<{ token: string; refreshed: boolean; user: AuthUser }>('/auth/refresh', {
      method: 'POST',
    });
  },

  async getOAuthProviders(): Promise<ApiResponse<{ providers: OAuthProvider[] }>> {
    return authApi<{ providers: OAuthProvider[] }>('/auth/oauth2/providers');
  },

  async startOAuth(provider: string): Promise<ApiResponse<OAuthStartResponse>> {
    return authApi<OAuthStartResponse>(`/auth/oauth2/${provider}/start`);
  },

  async completeOAuth(provider: string, code: string, state: string): Promise<ApiResponse<AuthResponse>> {
    return authApi<AuthResponse>(`/auth/oauth2/${provider}/callback`, {
      method: 'POST',
      body: JSON.stringify({ code, state }),
    });
  },

  async getPasskeyRegisterChallenge(): Promise<ApiResponse<{
    challenge: string;
    rp_id: string;
    origins: string[];
    user: { id: number; email: string };
    credential_ids: string[];
  }>> {
    return authApi<{
      challenge: string;
      rp_id: string;
      origins: string[];
      user: { id: number; email: string };
      credential_ids: string[];
    }>('/auth/passkey/register/challenge', {
      method: 'POST',
    });
  },

  async completePasskeyRegister(payload: {
    challenge: string;
    credential_id: string;
    client_data_json: string;
    attestation_object: string;
    transports?: string[];
  }): Promise<ApiResponse<{ credential_id: string }>> {
    return authApi<{ credential_id: string }>('/auth/passkey/register/complete', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async getPasskeyLoginChallenge(email: string): Promise<ApiResponse<{
    challenge: string;
    credential_ids: string[];
    rp_id: string;
    origins: string[];
  }>> {
    return authApi<{
      challenge: string;
      credential_ids: string[];
      rp_id: string;
      origins: string[];
    }>('/auth/passkey/login/challenge', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  },

  async completePasskeyLogin(payload: {
    email: string;
    credential_id: string;
    challenge: string;
    client_data_json: string;
    authenticator_data: string;
    signature: string;
  }): Promise<ApiResponse<AuthResponse>> {
    return authApi<AuthResponse>('/auth/passkey/login/complete', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async getUserProfile(): Promise<ApiResponse<UserProfile>> {
    return authApi<UserProfile>('/user_api/profile');
  },

  async getUserAddresses(): Promise<ApiResponse<UserAddressesResponse>> {
    return authApi<UserAddressesResponse>('/user_api/addresses');
  },

  async bindAddress(addressId: number, addressToken: string): Promise<ApiResponse<{ address_id: number; address: string }>> {
    void addressId;
    return authApi<{ address_id: number; address: string }>('/user_api/bind_address', {
      method: 'POST',
      body: JSON.stringify({ address_token: addressToken }),
    });
  },

  async logout(): Promise<ApiResponse<{ logged_out: boolean }>> {
    return authApi<{ logged_out: boolean }>('/auth/logout', {
      method: 'POST',
    });
  },

  async unbindAddress(addressId: number): Promise<ApiResponse<{ deleted: number }>> {
    return authApi<{ deleted: number }>('/user_api/unbind_address', {
      method: 'DELETE',
      body: JSON.stringify({ address_id: addressId }),
    });
  },

  async getUserMails(page = 1, limit = 20, address = '', keyword = ''): Promise<ApiResponse<UserMailsResponse>> {
    const query = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (address) query.set('address', address);
    if (keyword) query.set('keyword', keyword);
    return authApi<UserMailsResponse>(`/user_api/mails?${query.toString()}`);
  },

  async getAdminStats(adminPassword: string): Promise<ApiResponse<AdminStats>> {
    const response = await fetch('/admin_api/stats', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminPassword}`,
      },
    });
    return response.json();
  },

  async getAdminAddresses(adminPassword: string, page = 1, limit = 20, keyword = ''): Promise<ApiResponse<AdminAddressListResponse>> {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (keyword) params.set('keyword', keyword);
    const response = await fetch(`/admin_api/address?${params.toString()}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${adminPassword}`,
      },
    });
    return response.json();
  },

  async adminCreateAddress(adminPassword: string, payload: { name?: string; domain: string; password?: string }) {
    const response = await fetch('/admin_api/new_address', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminPassword}`,
      },
      body: JSON.stringify(payload),
    });
    return response.json();
  },

  async adminDeleteAddress(adminPassword: string, id: number) {
    const response = await fetch(`/admin_api/address/${id}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${adminPassword}`,
      },
    });
    return response.json();
  },

  async adminBulkDeleteAddress(adminPassword: string, ids: number[]) {
    const response = await fetch('/admin_api/address/bulk_delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminPassword}`,
      },
      body: JSON.stringify({ ids }),
    });
    return response.json();
  },

  async getAdminUsers(adminPassword: string, page = 1, limit = 20, keyword = ''): Promise<ApiResponse<AdminUserListResponse>> {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (keyword) params.set('keyword', keyword);
    const response = await fetch(`/admin_api/users?${params.toString()}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${adminPassword}`,
      },
    });
    return response.json();
  },

  async adminDeleteUser(adminPassword: string, id: number) {
    const response = await fetch(`/admin_api/users/${id}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${adminPassword}`,
      },
    });
    return response.json();
  },

  async adminUsersBulk(adminPassword: string, userIds: number[], action: string) {
    const response = await fetch('/admin_api/users/bulk', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminPassword}`,
      },
      body: JSON.stringify({ user_ids: userIds, action }),
    });
    return response.json();
  },

  async getAdminSettings(adminPassword: string): Promise<ApiResponse<AdminSettingsResponse>> {
    const response = await fetch('/admin_api/settings', {
      headers: {
        Authorization: `Bearer ${adminPassword}`,
      },
    });
    return response.json();
  },

  async updateAdminSettings(adminPassword: string, settings: Record<string, unknown>) {
    const response = await fetch('/admin_api/settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminPassword}`,
      },
      body: JSON.stringify({ settings }),
    });
    return response.json();
  },

  async adminCleanup(adminPassword: string, mode: string, days?: number) {
    const response = await fetch('/admin_api/cleanup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminPassword}`,
      },
      body: JSON.stringify({ mode, days }),
    });
    return response.json();
  },

  async adminDbInit(adminPassword: string): Promise<ApiResponse<AdminDbInitResponse>> {
    const response = await fetch('/admin_api/db_init', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminPassword}`,
      },
    });
    return response.json();
  },

  // Health check
  async health(): Promise<ApiResponse<{ status: string }>> {
    return api<{ status: string }>('/health');
  },
};

export type {
  Settings,
  Mail,
  Attachment,
  CreateAddressResponse,
  MailsResponse,
  SendboxMail,
  SendboxResponse,
  AuthResponse,
  AdminStats,
  AdminAddressRow,
  AdminUserRow,
  AdminSettingsRow,
  AdminDbInitResponse,
  UserProfile,
  UserAddressesResponse,
  UserMailsResponse,
  OAuthProvider,
};
