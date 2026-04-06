export interface Address {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
  password: string | null;
  source_ip: string | null;
  balance: number;
}

export interface CreateAddressInput {
  name: string;
  source_ip?: string;
  password?: string;
}

export interface AddressJWT {
  address_id: number;
  address: string;
  type: 'address';
  iat: number;
  exp: number;
}
