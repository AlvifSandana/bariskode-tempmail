<template>
  <div class="index-view">
    <!-- Header -->
    <header class="header">
      <div class="header-content">
        <h1 class="logo">📧 Temp Mail</h1>
        <div class="header-actions">
          <n-button text @click="goToUser">
            <template #icon>
              <n-icon><PersonOutline /></n-icon>
            </template>
            Account
          </n-button>
          <n-button text @click="goToAdmin">
            <template #icon>
              <n-icon><SettingsOutline /></n-icon>
            </template>
            Admin
          </n-button>
        </div>
      </div>
    </header>

    <!-- Announcement Banner -->
    <n-alert
      v-if="settingsStore.settings?.announcement"
      :title="settingsStore.settings.announcement"
      type="info"
      closable
      class="announcement"
    />

    <!-- Main Content -->
    <main class="main-content">
      <!-- Create Address Section -->
      <n-card v-if="!mailStore.hasAddress" class="create-card">
        <div class="create-section">
          <h2>Create Temporary Email Address</h2>
          <p class="description">
            Get a temporary email address instantly. No registration required.
          </p>

          <n-form ref="formRef" :model="formData" class="create-form">
            <n-form-item label="Custom Name (optional)">
              <n-input
                v-model:value="formData.name"
                placeholder="Enter custom name or leave empty for random"
                :disabled="settingsStore.settings?.disable_custom_address_name"
              />
            </n-form-item>

            <n-form-item v-if="settingsStore.settings?.enable_address_password" label="Password (optional)">
              <n-input
                v-model:value="formData.password"
                type="password"
                placeholder="Password to protect your inbox"
              />
            </n-form-item>

            <n-form-item v-if="availableDomains.length > 1" label="Domain">
              <n-select
                v-model:value="formData.domain"
                :options="domainOptions"
                placeholder="Select domain"
              />
            </n-form-item>

            <n-button
              type="primary"
              size="large"
              block
              :loading="mailStore.loading"
              @click="handleCreateAddress"
            >
              Create Email Address
            </n-button>
          </n-form>
        </div>
      </n-card>

      <!-- Address Info -->
      <n-card v-else class="address-card">
        <div class="address-info">
          <h3>Your Email Address</h3>
          <div class="address-display">
            <n-tag type="success" size="large">
              {{ mailStore.address }}
            </n-tag>
            <n-button size="small" @click="copyAddress">
              <template #icon>
                <n-icon><CopyOutline /></n-icon>
              </template>
            </n-button>
          </div>
          <p class="address-hint">
            Use this email address to receive emails. Refresh to check for new emails.
          </p>
          <n-button text type="error" @click="handleClearAddress">
            Clear Address
          </n-button>
        </div>
      </n-card>

      <!-- Inbox Section -->
      <n-card v-if="mailStore.hasAddress" class="inbox-card">
        <template #header>
          <div class="inbox-header">
            <h3>Inbox</h3>
            <n-button size="small" @click="refreshMails" :loading="mailStore.loading">
              <template #icon>
                <n-icon><RefreshOutline /></n-icon>
              </template>
              Refresh
            </n-button>
          </div>
        </template>

        <n-empty v-if="mailStore.mails.length === 0 && !mailStore.loading" description="No emails yet">
          <template #extra>
            <p>Send an email to your address to see it here</p>
          </template>
        </n-empty>

        <n-list v-else bordered>
          <n-list-item v-for="mail in mailStore.mails" :key="mail.id">
            <div class="mail-item" @click="viewMail(mail.id)">
              <div class="mail-sender">
                <n-tag :type="mail.is_read ? 'default' : 'success'" size="small">
                  {{ mail.is_read ? 'Read' : 'New' }}
                </n-tag>
                <span class="sender-text">{{ mail.sender || 'Unknown' }}</span>
              </div>
              <div class="mail-subject">{{ mail.subject || '(No Subject)' }}</div>
              <div class="mail-date">{{ formatDate(mail.created_at) }}</div>
            </div>
          </n-list-item>
        </n-list>

        <!-- Pagination -->
        <div v-if="mailStore.pagination.total_pages > 1" class="pagination">
          <n-pagination
            v-model:page="currentPage"
            :page-count="mailStore.pagination.total_pages"
            @update:page="handlePageChange"
          />
        </div>
      </n-card>

      <!-- Mail Detail Modal -->
      <n-modal v-model:show="showMailDetail" preset="card" style="width: 800px; max-width: 95vw;">
        <template #header>
          <div class="modal-header">
            <h3>{{ currentMailDetail?.subject || '(No Subject)' }}</h3>
            <n-button size="small" type="error" @click="handleDeleteMail">
              Delete
            </n-button>
          </div>
        </template>

        <div v-if="currentMailDetail" class="mail-detail">
          <div class="mail-meta">
            <p><strong>From:</strong> {{ currentMailDetail.sender }}</p>
            <p><strong>Date:</strong> {{ formatDate(currentMailDetail.created_at) }}</p>
          </div>

          <n-divider />

          <!-- HTML Content -->
          <div v-if="currentMailDetail.html" class="mail-content">
            <iframe
              :srcdoc="sanitizeHtml(currentMailDetail.html)"
              sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
              class="html-frame"
            />
          </div>

          <!-- Text Content -->
          <div v-else-if="currentMailDetail.text" class="mail-content text-content">
            <pre>{{ currentMailDetail.text }}</pre>
          </div>

          <n-empty v-else description="No content available" />

          <!-- Attachments -->
          <div v-if="currentMailDetail.attachments && currentMailDetail.attachments.length > 0" class="attachments">
            <h4>Attachments</h4>
            <n-list bordered>
              <n-list-item v-for="att in currentMailDetail.attachments" :key="att.id">
                <div class="attachment-item">
                  <n-icon><DocumentOutline /></n-icon>
                  <span>{{ att.filename || 'Attachment' }}</span>
                  <span class="attachment-size">{{ formatSize(att.size) }}</span>
                  <n-button
                    v-if="att.storage_key"
                    size="tiny"
                    tertiary
                    @click="downloadAttachment(att.id, att.filename)"
                  >
                    Download
                  </n-button>
                </div>
              </n-list-item>
            </n-list>
          </div>
        </div>
      </n-modal>
    </main>

    <!-- Footer -->
    <footer class="footer">
      <p>Self-hosted Temporary Email Service</p>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import {
  NButton,
  NCard,
  NInput,
  NForm,
  NFormItem,
  NSelect,
  NTag,
  NList,
  NListItem,
  NIcon,
  NAlert,
  NEmpty,
  NDivider,
  NModal,
  NPagination,
  useMessage,
} from 'naive-ui';
import {
  PersonOutline,
  SettingsOutline,
  CopyOutline,
  RefreshOutline,
  DocumentOutline,
} from '@vicons/ionicons5';
import DOMPurify from 'dompurify';
import { useMailStore } from '@/store/mail';
import { useSettingsStore } from '@/store/settings';
import { apiClient, getToken } from '@/api';
import type { Mail } from '@/api';

const router = useRouter();
const message = useMessage();
const mailStore = useMailStore();
const settingsStore = useSettingsStore();

const formRef = ref();
const formData = ref({
  name: '',
  password: '',
  domain: '',
});
const showMailDetail = ref(false);
const currentMailDetail = ref<Mail | null>(null);
const currentPage = ref(1);

// Computed
const availableDomains = computed(() => {
  return settingsStore.settings?.domains || [];
});

const domainOptions = computed(() => {
  return availableDomains.value.map(d => ({
    label: d,
    value: d,
  }));
});

// Methods
async function handleCreateAddress() {
  const result = await mailStore.createAddress(
    formData.value.name || undefined,
    formData.value.password || undefined,
    formData.value.domain || undefined
  );

  if (result) {
    message.success(`Created: ${result.address}`);
    fetchMails();
  } else if (mailStore.error) {
    message.error(mailStore.error);
  }
}

async function fetchMails() {
  await mailStore.fetchMails(currentPage.value);
}

async function refreshMails() {
  await mailStore.fetchMails(currentPage.value);
}

function handlePageChange(page: number) {
  currentPage.value = page;
  fetchMails();
}

async function viewMail(id: number) {
  const mail = await mailStore.fetchMail(id);
  if (mail) {
    currentMailDetail.value = mail;
    showMailDetail.value = true;
  }
}

async function handleDeleteMail() {
  if (!currentMailDetail.value) return;

  const success = await mailStore.deleteMail(currentMailDetail.value.id);
  if (success) {
    showMailDetail.value = false;
    currentMailDetail.value = null;
    message.success('Email deleted');
  } else if (mailStore.error) {
    message.error(mailStore.error);
  }
}

function handleClearAddress() {
  mailStore.clearAddress();
  currentPage.value = 1;
  message.info('Address cleared');
}

function copyAddress() {
  if (mailStore.address) {
    navigator.clipboard.writeText(mailStore.address);
    message.success('Copied to clipboard');
  }
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString();
}

function formatSize(bytes: number | null): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html);
}

function downloadAttachment(attachmentId: number, filename: string | null) {
  if (!currentMailDetail.value) return;
  const token = getToken();
  if (!token) {
    message.error('Session expired. Please recreate or restore your address.');
    return;
  }

  const url = apiClient.getAttachmentDownloadUrl(currentMailDetail.value.id, attachmentId);
  fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error('Attachment download failed');
      }

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename || `attachment-${attachmentId}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(blobUrl);
    })
    .catch(() => {
      message.error('Failed to download attachment');
    });
}

function goToUser() {
  router.push('/user');
}

function goToAdmin() {
  router.push('/admin');
}

// Lifecycle
onMounted(async () => {
  await settingsStore.fetchSettings();
  mailStore.restoreSession();

  // Set default domain
  if (availableDomains.value.length > 0) {
    formData.value.domain = availableDomains.value[0];
  }

  // Fetch mails if we have a token
  if (mailStore.hasAddress) {
    fetchMails();
  }
});
</script>

<style scoped>
.index-view {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.header {
  background: #2a2a2a;
  border-bottom: 1px solid #3a3a3a;
  padding: 16px 24px;
}

.header-content {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.logo {
  font-size: 24px;
  font-weight: bold;
  color: #fff;
  margin: 0;
}

.header-actions {
  display: flex;
  gap: 16px;
}

.announcement {
  margin: 16px auto;
  max-width: 1200px;
}

.main-content {
  flex: 1;
  padding: 24px;
  max-width: 1200px;
  margin: 0 auto;
  width: 100%;
}

.create-card,
.address-card,
.inbox-card {
  margin-bottom: 24px;
}

.create-section {
  text-align: center;
  padding: 24px;
}

.create-section h2 {
  margin-bottom: 8px;
  color: #fff;
}

.description {
  color: #888;
  margin-bottom: 24px;
}

.create-form {
  max-width: 400px;
  margin: 0 auto;
  text-align: left;
}

.address-info {
  text-align: center;
}

.address-info h3 {
  margin-bottom: 16px;
}

.address-display {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-bottom: 12px;
}

.address-hint {
  color: #888;
  font-size: 14px;
  margin-bottom: 12px;
}

.inbox-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.inbox-header h3 {
  margin: 0;
}

.mail-item {
  cursor: pointer;
  width: 100%;
}

.mail-item:hover {
  opacity: 0.8;
}

.mail-sender {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.sender-text {
  color: #fff;
  font-weight: 500;
}

.mail-subject {
  color: #ccc;
  margin-bottom: 4px;
}

.mail-date {
  color: #888;
  font-size: 12px;
}

.pagination {
  margin-top: 16px;
  display: flex;
  justify-content: center;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.modal-header h3 {
  margin: 0;
}

.mail-detail {
  padding: 0;
}

.mail-meta {
  margin-bottom: 16px;
}

.mail-meta p {
  margin: 4px 0;
  color: #ccc;
}

.mail-content {
  max-height: 400px;
  overflow-y: auto;
}

.html-frame {
  width: 100%;
  min-height: 300px;
  border: none;
  background: #fff;
}

.text-content {
  background: #2a2a2a;
  padding: 16px;
  border-radius: 8px;
}

.text-content pre {
  margin: 0;
  white-space: pre-wrap;
  word-wrap: break-word;
  color: #ccc;
  font-family: inherit;
}

.attachments {
  margin-top: 16px;
}

.attachments h4 {
  margin-bottom: 8px;
}

.attachment-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.attachment-size {
  color: #888;
  font-size: 12px;
  margin-left: auto;
}

.footer {
  text-align: center;
  padding: 24px;
  color: #666;
  border-top: 1px solid #3a3a3a;
}

.footer p {
  margin: 0;
}
</style>
