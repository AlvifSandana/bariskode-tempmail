export interface Settings {
  announcement: string;
  spam_list: string[];
  blacklist: string[];
  whitelist: string[];
  default_domains: string[];
  user_roles_config: RoleConfig[];
  ai_extract_settings: AIExtractSettings;
  address_name_blacklist: string[];
  ip_blacklist: string[];
  cleanup_rules: CleanupRules;
  custom_sql_cleanup: string;
}

export interface RoleConfig {
  name: string;
  domains: string[];
  prefix: string;
  max_address: number;
}

export interface AIExtractSettings {
  enabled: boolean;
  address_whitelist: string[];
}

export interface CleanupRules {
  max_age_days: number;
  cleanup_empty: boolean;
  cleanup_unbound: boolean;
}

export interface PublicSettings {
  domains: string[];
  announcement: string;
  enable_address_password: boolean;
  disable_custom_address_name: boolean;
  always_show_announcement: boolean;
  prefix: string;
}

export interface SettingRow {
  key: string;
  value: string;
}
