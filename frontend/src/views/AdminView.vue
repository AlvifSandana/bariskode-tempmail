<template>
  <div class="admin-view">
    <n-card title="Admin Panel">
      <n-space vertical :size="16">
        <n-form :model="form" inline>
          <n-form-item label="Admin Password">
            <n-input v-model:value="form.password" type="password" placeholder="Bearer password" style="width: 320px" />
          </n-form-item>
          <n-form-item>
            <n-button type="primary" :loading="loading" @click="loginAndLoad">Authenticate</n-button>
          </n-form-item>
        </n-form>

        <n-tabs v-if="authed" type="line">
          <n-tab-pane name="overview" tab="Overview">
            <n-card size="small">
              <n-space vertical :size="6">
                <div><strong>Addresses:</strong> {{ stats?.addresses ?? '-' }}</div>
                <div><strong>Users:</strong> {{ stats?.users ?? '-' }}</div>
                <div><strong>Mails:</strong> {{ stats?.mails ?? '-' }}</div>
                <div><strong>Sent mails:</strong> {{ stats?.sent_mails ?? '-' }}</div>
              </n-space>
            </n-card>
          </n-tab-pane>

          <n-tab-pane name="addresses" tab="Addresses">
            <n-space style="margin-bottom: 8px">
              <n-input v-model:value="addressKeyword" placeholder="Search address" style="width: 240px" />
              <n-button size="small" @click="loadAddresses(1)">Search</n-button>
            </n-space>
            <n-data-table :columns="addressColumns" :data="addresses" :pagination="false" />
            <div style="margin-top: 8px">
              <n-pagination v-model:page="addressPage" :page-count="addressPagination.total_pages || 1" @update:page="loadAddresses" />
            </div>
            <n-divider />
            <n-form :model="createAddressForm" inline>
              <n-form-item label="Name">
                <n-input v-model:value="createAddressForm.name" placeholder="optional" />
              </n-form-item>
              <n-form-item label="Domain">
                <n-input v-model:value="createAddressForm.domain" placeholder="example.com" />
              </n-form-item>
              <n-form-item label="Password">
                <n-input v-model:value="createAddressForm.password" type="password" placeholder="optional" />
              </n-form-item>
              <n-form-item>
                <n-button size="small" type="primary" @click="createAddress">Create</n-button>
              </n-form-item>
            </n-form>
          </n-tab-pane>

          <n-tab-pane name="users" tab="Users">
            <n-space style="margin-bottom: 8px">
              <n-input v-model:value="userKeyword" placeholder="Search user" style="width: 240px" />
              <n-button size="small" @click="loadUsers(1)">Search</n-button>
            </n-space>
            <n-data-table :columns="userColumns" :data="users" :pagination="false" />
            <div style="margin-top: 8px">
              <n-pagination v-model:page="userPage" :page-count="userPagination.total_pages || 1" @update:page="loadUsers" />
            </div>
          </n-tab-pane>

          <n-tab-pane name="settings" tab="Settings">
            <n-space vertical>
              <n-input v-model:value="settingsEdit.announcement" type="textarea" placeholder="Announcement" />
              <n-input v-model:value="settingsEdit.default_domains" placeholder='default_domains JSON, e.g. ["a.com"]' />
              <n-input v-model:value="settingsEdit.address_name_blacklist" placeholder='address_name_blacklist JSON' />
              <n-input v-model:value="settingsEdit.ip_blacklist" placeholder='ip_blacklist JSON' />
              <n-button type="primary" size="small" @click="saveSettings">Save Settings</n-button>
              <n-alert type="default">Unsupported keys are blocked by backend allowlist.</n-alert>
            </n-space>
          </n-tab-pane>

          <n-tab-pane name="maintenance" tab="Maintenance">
            <n-space>
              <n-button size="small" @click="runCleanup('old_emails')">Cleanup old mails</n-button>
              <n-button size="small" @click="runCleanup('empty_addresses')">Cleanup empty addresses</n-button>
              <n-button size="small" @click="runCleanup('unbound_addresses')">Cleanup unbound addresses</n-button>
            </n-space>
            <n-divider />
            <n-button size="small" @click="checkDbInit">Check DB init status</n-button>
            <n-card size="small" v-if="dbInit">
              <div><strong>Initialized:</strong> {{ dbInit.initialized ? 'yes' : 'no' }}</div>
              <div><strong>Missing:</strong> {{ dbInit.missing_core_tables.join(', ') || '-' }}</div>
              <div><strong>Next action:</strong> {{ dbInit.next_action }}</div>
            </n-card>
          </n-tab-pane>
        </n-tabs>
      </n-space>
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { h, ref } from 'vue';
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NDivider,
  NForm,
  NFormItem,
  NInput,
  NPagination,
  NSpace,
  NTabPane,
  NTabs,
  useMessage,
} from 'naive-ui';
import { apiClient } from '@/api';
import type { AdminAddressRow, AdminDbInitResponse, AdminStats, AdminUserRow } from '@/api';

const message = useMessage();

const form = ref({ password: '' });
const loading = ref(false);
const authed = ref(false);

const stats = ref<AdminStats | null>(null);
const addresses = ref<AdminAddressRow[]>([]);
const addressKeyword = ref('');
const addressPage = ref(1);
const addressPagination = ref({ page: 1, limit: 20, total: 0, total_pages: 0 });
const createAddressForm = ref({ name: '', domain: '', password: '' });

const users = ref<AdminUserRow[]>([]);
const userKeyword = ref('');
const userPage = ref(1);
const userPagination = ref({ page: 1, limit: 20, total: 0, total_pages: 0 });

const settingsEdit = ref({
  announcement: '',
  default_domains: '[]',
  address_name_blacklist: '[]',
  ip_blacklist: '[]',
});

const dbInit = ref<AdminDbInitResponse | null>(null);

const addressColumns = [
  { title: 'ID', key: 'id' },
  { title: 'Address', key: 'name' },
  { title: 'Mail Count', key: 'mail_count' },
  { title: 'User ID', key: 'user_id' },
  {
    title: 'Action',
    key: 'action',
    render: (row: AdminAddressRow) =>
      h(
        NButton,
        {
          size: 'tiny',
          type: 'error',
          onClick: () => deleteAddress(row.id),
        },
        { default: () => 'Delete' }
      ),
  },
];

const userColumns = [
  { title: 'ID', key: 'id' },
  { title: 'Email', key: 'user_email' },
  { title: 'Address Count', key: 'address_count' },
  {
    title: 'Action',
    key: 'action',
    render: (row: AdminUserRow) =>
      h(
        NSpace,
        {},
        {
          default: () => [
            h(
              NButton,
              { size: 'tiny', onClick: () => bulkUser([row.id], 'clear_inbox') },
              { default: () => 'Clear Inbox' }
            ),
            h(
              NButton,
              { size: 'tiny', onClick: () => bulkUser([row.id], 'clear_sent') },
              { default: () => 'Clear Sent' }
            ),
            h(
              NButton,
              { size: 'tiny', type: 'error', onClick: () => deleteUser(row.id) },
              { default: () => 'Delete' }
            ),
          ],
        }
      ),
  },
];

async function loginAndLoad() {
  loading.value = true;
  try {
    const res = await apiClient.getAdminStats(form.value.password);
    if (!res.success || !res.data) {
      authed.value = false;
      message.error(res.message || 'Admin auth failed');
      return;
    }
    authed.value = true;
    stats.value = res.data;
    await Promise.all([loadAddresses(1), loadUsers(1), loadSettings()]);
    message.success('Authenticated');
  } finally {
    loading.value = false;
  }
}

async function loadAddresses(page = 1) {
  addressPage.value = page;
  const res = await apiClient.getAdminAddresses(form.value.password, page, 20, addressKeyword.value);
  if (!res.success || !res.data) {
    message.error(res.message || 'Failed to load addresses');
    return;
  }
  addresses.value = res.data.addresses;
  addressPagination.value = res.data.pagination;
}

async function createAddress() {
  const res = await apiClient.adminCreateAddress(form.value.password, {
    name: createAddressForm.value.name || undefined,
    domain: createAddressForm.value.domain,
    password: createAddressForm.value.password || undefined,
  });
  if (!res.success) {
    message.error(res.message || 'Create failed');
    return;
  }
  message.success('Address created');
  await loadAddresses(addressPage.value);
}

async function deleteAddress(id: number) {
  const res = await apiClient.adminDeleteAddress(form.value.password, id);
  if (!res.success) {
    message.error(res.message || 'Delete failed');
    return;
  }
  message.success('Address deleted');
  await loadAddresses(addressPage.value);
}

async function loadUsers(page = 1) {
  userPage.value = page;
  const res = await apiClient.getAdminUsers(form.value.password, page, 20, userKeyword.value);
  if (!res.success || !res.data) {
    message.error(res.message || 'Failed to load users');
    return;
  }
  users.value = res.data.users;
  userPagination.value = res.data.pagination;
}

async function deleteUser(id: number) {
  const res = await apiClient.adminDeleteUser(form.value.password, id);
  if (!res.success) {
    message.error(res.message || 'Delete user failed');
    return;
  }
  message.success('User deleted');
  await loadUsers(userPage.value);
}

async function bulkUser(userIds: number[], action: string) {
  const res = await apiClient.adminUsersBulk(form.value.password, userIds, action);
  if (!res.success) {
    message.error(res.message || 'Bulk action failed');
    return;
  }
  message.success(`Bulk action ${action} completed`);
}

async function loadSettings() {
  const res = await apiClient.getAdminSettings(form.value.password);
  if (!res.success || !res.data) {
    return;
  }
  const map = new Map(res.data.settings.map((row) => [row.key, row.value]));
  settingsEdit.value.announcement = String(map.get('announcement') || '');
  settingsEdit.value.default_domains = String(map.get('default_domains') || '[]');
  settingsEdit.value.address_name_blacklist = String(map.get('address_name_blacklist') || '[]');
  settingsEdit.value.ip_blacklist = String(map.get('ip_blacklist') || '[]');
}

async function saveSettings() {
  const payload = {
    announcement: settingsEdit.value.announcement,
    default_domains: parseJsonArray(settingsEdit.value.default_domains),
    address_name_blacklist: parseJsonArray(settingsEdit.value.address_name_blacklist),
    ip_blacklist: parseJsonArray(settingsEdit.value.ip_blacklist),
  };
  const res = await apiClient.updateAdminSettings(form.value.password, payload);
  if (!res.success) {
    message.error(res.message || 'Save settings failed');
    return;
  }
  message.success('Settings saved');
}

async function runCleanup(mode: string) {
  const res = await apiClient.adminCleanup(form.value.password, mode, 7);
  if (!res.success) {
    message.error(res.message || 'Cleanup failed');
    return;
  }
  message.success(`Cleanup done: ${mode}`);
  await Promise.all([loadAddresses(addressPage.value), loadUsers(userPage.value), loginAndLoad()]);
}

async function checkDbInit() {
  const res = await apiClient.adminDbInit(form.value.password);
  if (!res.success || !res.data) {
    message.error(res.message || 'DB status failed');
    return;
  }
  dbInit.value = res.data;
}

function parseJsonArray(input: string): string[] {
  try {
    const parsed = JSON.parse(input);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}
</script>

<style scoped>
.admin-view {
  padding: 24px;
  max-width: 1100px;
  margin: 0 auto;
}
</style>
