<template>
  <div class="user-view">
    <n-card title="User Account">
      <n-tabs v-model:value="activeTab" type="line">
        <n-tab-pane name="login" tab="Login / Register">
          <n-space vertical :size="16">
            <n-alert type="info">
              User session is separate from temporary address session.
            </n-alert>

            <n-form :model="loginForm" label-placement="top">
              <n-form-item label="Email">
                <n-input v-model:value="loginForm.email" placeholder="you@example.com" />
              </n-form-item>
              <n-form-item label="Password">
                <n-input v-model:value="loginForm.password" type="password" placeholder="Password" />
              </n-form-item>
              <n-space>
                <n-button type="primary" :loading="loginLoading" @click="handleLogin">Login</n-button>
                <n-button :loading="registerLoading" @click="handleRegister">Register</n-button>
              </n-space>
            </n-form>

            <n-divider>OAuth2 (Google)</n-divider>
            <n-button tertiary :loading="oauthLoading" @click="startGoogleOAuth">
              Continue with Google
            </n-button>

            <n-divider>Passkey</n-divider>
            <n-space>
              <n-button tertiary :loading="passkeyLoginLoading" @click="handlePasskeyLogin">Passkey Login</n-button>
              <n-button tertiary :disabled="!userToken" :loading="passkeyRegisterLoading" @click="handlePasskeyRegister">
                Register Passkey
              </n-button>
            </n-space>
          </n-space>
        </n-tab-pane>

        <n-tab-pane name="dashboard" tab="Dashboard">
          <template v-if="!userToken">
            <n-empty description="Please login first" />
          </template>
          <template v-else>
            <n-space vertical :size="16">
              <n-card size="small" title="Profile">
                <div><strong>Email:</strong> {{ profile?.user_email || '-' }}</div>
                <div><strong>Roles:</strong> {{ (profile?.roles || []).join(', ') || '-' }}</div>
                <n-space style="margin-top: 8px">
                  <n-button size="small" @click="refreshProfile">Refresh</n-button>
                  <n-button size="small" type="warning" @click="logout">Logout</n-button>
                </n-space>
              </n-card>

              <n-card size="small" title="Bind Current Temp Address">
                <n-alert type="default" style="margin-bottom: 8px">
                  If you currently have an address session on home page, you can bind it here.
                </n-alert>
                <n-button size="small" :disabled="!canBindCurrentAddress" :loading="binding" @click="bindCurrentAddress">
                  Bind current temp address
                </n-button>
              </n-card>

              <n-card size="small" title="Bound Addresses">
                <n-list bordered>
                  <n-list-item v-for="addr in addresses" :key="addr.id">
                    <n-space justify="space-between" style="width: 100%">
                      <div>
                        <div>{{ addr.name }}</div>
                        <small>Bound: {{ formatDate(addr.bound_at) }}</small>
                      </div>
                      <n-button size="tiny" type="error" @click="unbind(addr.id)">Unbind</n-button>
                    </n-space>
                  </n-list-item>
                </n-list>
              </n-card>

              <n-card size="small" title="User Mailbox">
                <n-space style="margin-bottom: 8px">
                  <n-input v-model:value="mailFilter.address" placeholder="Filter address" style="width: 220px" />
                  <n-input v-model:value="mailFilter.keyword" placeholder="Keyword" style="width: 220px" />
                  <n-button size="small" @click="loadUserMails(1)">Search</n-button>
                </n-space>
                <n-list bordered>
                  <n-list-item v-for="mail in userMails" :key="mail.id">
                    <div>
                      <strong>{{ mail.subject || '(No Subject)' }}</strong>
                      <div>{{ mail.sender || '-' }} → {{ mail.address }}</div>
                      <small>{{ formatDate(mail.created_at) }}</small>
                    </div>
                  </n-list-item>
                </n-list>
                <div style="margin-top: 8px">
                  <n-pagination
                    v-model:page="userMailsPage"
                    :page-count="userMailsPagination.total_pages || 1"
                    @update:page="loadUserMails"
                  />
                </div>
              </n-card>
            </n-space>
          </template>
        </n-tab-pane>
      </n-tabs>
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NAlert,
  NButton,
  NCard,
  NDivider,
  NEmpty,
  NForm,
  NFormItem,
  NInput,
  NList,
  NListItem,
  NPagination,
  NSpace,
  NTabPane,
  NTabs,
  useMessage,
} from 'naive-ui';
import { apiClient, clearUserToken, getAddress, getToken, saveUserToken } from '@/api';
import type { Mail, UserAddressesResponse, UserProfile } from '@/api';

const message = useMessage();
const router = useRouter();
const route = useRoute();

const activeTab = ref<'login' | 'dashboard'>('login');
const loginLoading = ref(false);
const registerLoading = ref(false);
const oauthLoading = ref(false);
const passkeyRegisterLoading = ref(false);
const passkeyLoginLoading = ref(false);
const binding = ref(false);

const loginForm = ref({ email: '', password: '' });
const userToken = ref<string | null>(null);
const profile = ref<UserProfile | null>(null);
const addresses = ref<UserAddressesResponse['addresses']>([]);
const userMails = ref<Mail[]>([]);
const userMailsPage = ref(1);
const userMailsPagination = ref({ page: 1, limit: 20, total: 0, total_pages: 0 });
const mailFilter = ref({ address: '', keyword: '' });

const canBindCurrentAddress = computed(() => !!getToken() && !!getAddress());

async function bootstrapAfterLogin() {
  const refreshed = await apiClient.refreshUserToken();
  if (!refreshed.success || !refreshed.data) return false;
  saveUserToken('', refreshed.data.user.user_email);
  userToken.value = 'session';
  activeTab.value = 'dashboard';
  await Promise.all([refreshProfile(), refreshAddresses(), loadUserMails(1)]);
  return true;
}

async function handleLogin() {
  loginLoading.value = true;
  try {
    const res = await apiClient.login(loginForm.value.email, loginForm.value.password);
    if (!res.success || !res.data) {
      message.error(res.message || 'Login failed');
      return;
    }
    saveUserToken('', res.data.user.user_email);
    userToken.value = 'session';
    message.success('Login successful');
    await bootstrapAfterLogin().catch(() => false);
    router.replace('/user');
  } catch {
    message.error('Network error');
  } finally {
    loginLoading.value = false;
  }
}

async function handleRegister() {
  registerLoading.value = true;
  try {
    const res = await apiClient.register(loginForm.value.email, loginForm.value.password);
    if (!res.success || !res.data) {
      message.error(res.message || 'Registration failed');
      return;
    }
    saveUserToken('', res.data.user.user_email);
    userToken.value = 'session';
    message.success('Registration successful');
    await bootstrapAfterLogin().catch(() => false);
    router.replace('/user');
  } catch {
    message.error('Network error');
  } finally {
    registerLoading.value = false;
  }
}

async function startGoogleOAuth() {
  oauthLoading.value = true;
  try {
    const start = await apiClient.startOAuth('google');
    if (!start.success || !start.data) {
      message.error(start.message || 'OAuth unavailable');
      return;
    }
    window.location.href = start.data.auth_url;
  } catch {
    message.error('Failed to start OAuth');
  } finally {
    oauthLoading.value = false;
  }
}

async function tryOAuthCallback() {
  const code = String(route.query.code || '');
  const state = String(route.query.state || '');
  if (!code || !state) return false;

  oauthLoading.value = true;
  try {
    const res = await apiClient.completeOAuth('google', code, state);
    if (!res.success || !res.data) {
      message.error(res.message || 'OAuth login failed');
      return false;
    }
    saveUserToken('', res.data.user.user_email);
    userToken.value = 'session';
    message.success('OAuth login successful');
    await bootstrapAfterLogin().catch(() => false);
    return true;
  } catch {
    message.error('OAuth callback failed');
    return false;
  } finally {
    oauthLoading.value = false;
    router.replace('/user');
  }
}

async function handlePasskeyRegister() {
  if (!userToken.value) {
    message.error('Login required');
    return;
  }
  passkeyRegisterLoading.value = true;
  try {
    if (!('credentials' in navigator) || typeof PublicKeyCredential === 'undefined') {
      message.error('Passkey is not supported in this browser');
      return;
    }

    const challengeRes = await apiClient.getPasskeyRegisterChallenge();
    if (!challengeRes.success || !challengeRes.data) {
      message.error(challengeRes.message || 'Failed to create challenge');
      return;
    }

    const createOptions: CredentialCreationOptions = {
      publicKey: {
        challenge: fromBase64Url(challengeRes.data.challenge).buffer,
        rp: {
          name: 'TempMail',
          id: challengeRes.data.rp_id,
        },
        user: {
          id: new TextEncoder().encode(String(challengeRes.data.user.id)),
          name: challengeRes.data.user.email,
          displayName: challengeRes.data.user.email,
        },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        timeout: 60000,
        attestation: 'none',
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'required',
        },
        excludeCredentials: challengeRes.data.credential_ids.map((id) => ({
          type: 'public-key',
          id: fromBase64Url(id).buffer,
        })),
      },
    };

    const credential = (await navigator.credentials.create(createOptions)) as PublicKeyCredential | null;
    if (!credential) {
      message.error('Passkey registration canceled');
      return;
    }
    const response = credential.response as AuthenticatorAttestationResponse;
    const transports = typeof response.getTransports === 'function' ? response.getTransports() : [];
    const credentialId = toBase64Url(new Uint8Array(credential.rawId));

    const completeRes = await apiClient.completePasskeyRegister({
      challenge: challengeRes.data.challenge,
      credential_id: credentialId,
      client_data_json: toBase64Url(new Uint8Array(response.clientDataJSON)),
      attestation_object: toBase64Url(new Uint8Array(response.attestationObject)),
      transports,
    });
    if (!completeRes.success) {
      message.error(completeRes.message || 'Passkey registration failed');
      return;
    }
    message.success('Passkey registered');
  } catch {
    message.error('Passkey registration failed');
  } finally {
    passkeyRegisterLoading.value = false;
  }
}

async function handlePasskeyLogin() {
  passkeyLoginLoading.value = true;
  try {
    if (!('credentials' in navigator) || typeof PublicKeyCredential === 'undefined') {
      message.error('Passkey is not supported in this browser');
      return;
    }

    const email = loginForm.value.email.trim().toLowerCase();
    if (!email) {
      message.error('Input email first for passkey login');
      return;
    }

    const challengeRes = await apiClient.getPasskeyLoginChallenge(email);
    if (!challengeRes.success || !challengeRes.data || challengeRes.data.credential_ids.length === 0) {
      message.error(challengeRes.message || 'No passkey available');
      return;
    }

    const credential = (await navigator.credentials.get({
      publicKey: {
        challenge: fromBase64Url(challengeRes.data.challenge).buffer,
        rpId: challengeRes.data.rp_id,
        timeout: 60000,
        userVerification: 'required',
        allowCredentials: challengeRes.data.credential_ids.map((id) => ({
          type: 'public-key',
          id: fromBase64Url(id).buffer,
        })),
      },
    })) as PublicKeyCredential | null;

    if (!credential) {
      message.error('Passkey login canceled');
      return;
    }
    const response = credential.response as AuthenticatorAssertionResponse;
    const credentialId = toBase64Url(new Uint8Array(credential.rawId));

    const loginRes = await apiClient.completePasskeyLogin({
      email,
      credential_id: credentialId,
      challenge: challengeRes.data.challenge,
      client_data_json: toBase64Url(new Uint8Array(response.clientDataJSON)),
      authenticator_data: toBase64Url(new Uint8Array(response.authenticatorData)),
      signature: toBase64Url(new Uint8Array(response.signature)),
    });

    if (!loginRes.success || !loginRes.data) {
      message.error(loginRes.message || 'Passkey login failed');
      return;
    }

    saveUserToken('', loginRes.data.user.user_email);
    userToken.value = 'session';
    message.success('Passkey login successful');
    await bootstrapAfterLogin().catch(() => false);
    router.replace('/user');
  } catch {
    message.error('Passkey login failed');
  } finally {
    passkeyLoginLoading.value = false;
  }
}

async function refreshProfile() {
  const res = await apiClient.getUserProfile();
  if (res.success && res.data) {
    profile.value = res.data;
  }
}

async function refreshAddresses() {
  const res = await apiClient.getUserAddresses();
  if (res.success && res.data) {
    addresses.value = res.data.addresses;
  }
}

async function bindCurrentAddress() {
  binding.value = true;
  try {
    const token = getToken();
    const address = getAddress();
    if (!token || !address) {
      message.error('No active temp address session found');
      return;
    }

    const res = await apiClient.bindAddress(0, token);
    if (!res.success) {
      message.error(res.message || 'Bind failed');
      return;
    }
    message.success(`Bound ${address}`);
    await refreshAddresses();
  } finally {
    binding.value = false;
  }
}

async function unbind(addressId: number) {
  const res = await apiClient.unbindAddress(addressId);
  if (!res.success) {
    message.error(res.message || 'Unbind failed');
    return;
  }
  message.success('Address unbound');
  await refreshAddresses();
}

async function loadUserMails(page = 1) {
  userMailsPage.value = page;
  const res = await apiClient.getUserMails(page, 20, mailFilter.value.address, mailFilter.value.keyword);
  if (!res.success || !res.data) {
    message.error(res.message || 'Failed to load mails');
    return;
  }
  userMails.value = res.data.mails;
  userMailsPagination.value = res.data.pagination;
}

async function logout() {
  await apiClient.logout().catch(() => null);
  clearUserToken();
  userToken.value = null;
  profile.value = null;
  addresses.value = [];
  userMails.value = [];
  activeTab.value = 'login';
}

function formatDate(input: string): string {
  return new Date(input).toLocaleString();
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  const binary = atob(normalized);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

onMounted(async () => {
  const handledOAuth = await tryOAuthCallback();
  if (!handledOAuth) {
    await bootstrapAfterLogin();
  }
});
</script>

<style scoped>
.user-view {
  padding: 24px;
  max-width: 900px;
  margin: 0 auto;
}
</style>
