export interface User {
  id: number;
  user_email: string | null;
  password: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserWithRoles extends User {
  roles: string[];
}

export interface UserRole {
  id: number;
  user_id: number;
  role_text: string;
  created_at: string;
}

export interface UserAddress {
  id: number;
  user_id: number;
  address_id: number;
  created_at: string;
}

export interface UserJWT {
  user_id: number;
  user_email: string | null;
  roles: string[];
  type: 'user';
  iat: number;
  exp: number;
}

export interface RoleConfig {
  name: string;
  domains: string[];
  prefix: string;
  max_address: number;
}

export interface WebAuthnCredential {
  id: number;
  user_id: number;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  created_at: string;
}

export interface OAuthConnection {
  id: number;
  user_id: number;
  provider: string;
  provider_id: string;
  created_at: string;
}
