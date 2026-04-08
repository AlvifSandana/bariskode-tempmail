import type { AppBindings } from '../types/env';
import { getSetting } from './db';

export type RolePolicy = {
  name: string;
  domains: string[];
  prefix: string;
  max_address: number;
};

type RawRolePolicy = Partial<RolePolicy> & { name?: unknown; max_address?: unknown; domains?: unknown; prefix?: unknown };

function normalizeRolePolicies(input: unknown): RolePolicy[] {
  if (!Array.isArray(input)) return [];

  return input
    .map((item) => item as RawRolePolicy)
    .map((item) => {
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      if (!name) return null;

      const maxAddressRaw = Number(item.max_address);
      if (!Number.isInteger(maxAddressRaw) || maxAddressRaw < 0) return null;

      const domains = Array.isArray(item.domains)
        ? item.domains.map((v) => String(v).trim()).filter(Boolean)
        : [];
      const prefix = typeof item.prefix === 'string' ? item.prefix : '';

      return {
        name,
        domains,
        prefix,
        max_address: maxAddressRaw,
      } as RolePolicy;
    })
    .filter((item): item is RolePolicy => item !== null);
}

function parseEnvRolePolicies(env: AppBindings): RolePolicy[] {
  try {
    return normalizeRolePolicies(JSON.parse(env.USER_ROLES || '[]'));
  } catch {
    return [];
  }
}

export async function getRolePolicies(env: AppBindings): Promise<RolePolicy[]> {
  const settingsPolicies = await getSetting<unknown>(env.DB, 'user_roles_config', []);
  const normalizedSettings = normalizeRolePolicies(settingsPolicies);
  if (normalizedSettings.length > 0) {
    return normalizedSettings;
  }

  return parseEnvRolePolicies(env);
}

export async function resolveEffectiveRolePolicy(
  env: AppBindings,
  userRoles: string[]
): Promise<RolePolicy | null> {
  const policies = await getRolePolicies(env);
  if (policies.length === 0) return null;

  const findPolicyByName = (name: string): RolePolicy | null => {
    for (const policy of policies) {
      if (policy.name === name) return policy;
    }
    return null;
  };

  const normalizedUserRoles = userRoles.map((role) => String(role || '').trim()).filter(Boolean);
  const defaultRole = String(env.USER_DEFAULT_ROLE || 'default').trim();
  const candidates = Array.from(new Set([...normalizedUserRoles, defaultRole].filter(Boolean)));

  for (const candidate of candidates) {
    const found = findPolicyByName(candidate);
    if (found) {
      return found;
    }
  }

  const defaultPolicy = findPolicyByName('default');
  if (defaultPolicy) return defaultPolicy;

  return null;
}

export function getAllowedDomainsForRolePolicy(policy: RolePolicy, envDomains: string[]): string[] {
  const normalizedEnvDomains = envDomains.map((domain) => String(domain || '').trim().toLowerCase()).filter(Boolean);
  const requested = Array.isArray(policy.domains)
    ? policy.domains.map((domain) => String(domain || '').trim().toLowerCase()).filter(Boolean)
    : [];

  if (requested.includes('*')) return normalizedEnvDomains;
  return requested.filter((domain) => normalizedEnvDomains.includes(domain));
}
