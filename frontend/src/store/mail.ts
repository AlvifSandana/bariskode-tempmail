import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  apiClient,
  saveToken,
  getToken,
  getAddress,
  clearToken,
} from '@/api';
import type { Mail, Settings, MailsResponse } from '@/api';

export const useMailStore = defineStore('mail', () => {
  // State
  const address = ref<string | null>(getAddress());
  const token = ref<string | null>(getToken());
  const mails = ref<Mail[]>([]);
  const currentMail = ref<Mail | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const pagination = ref({
    page: 1,
    limit: 20,
    total: 0,
    total_pages: 0,
  });

  // Computed
  const hasAddress = computed(() => !!address.value);
  const unreadCount = computed(() => mails.value.filter(m => !m.is_read).length);

  // Actions
  async function createAddress(name?: string, password?: string, domain?: string) {
    loading.value = true;
    error.value = null;

    try {
      const response = await apiClient.createAddress(name, password, domain);

      if (response.success && response.data) {
        address.value = response.data.address;
        token.value = response.data.token;
        saveToken(response.data.token, response.data.address);
        return response.data;
      } else {
        error.value = response.message || 'Failed to create address';
        return null;
      }
    } catch (e) {
      error.value = 'Network error';
      return null;
    } finally {
      loading.value = false;
    }
  }

  async function fetchMails(page: number = 1) {
    if (!token.value) return;

    loading.value = true;
    error.value = null;

    try {
      const response = await apiClient.getMails(page, pagination.value.limit);

      if (response.success && response.data) {
        mails.value = response.data.mails;
        pagination.value = response.data.pagination;
      } else {
        error.value = response.message || 'Failed to fetch mails';
      }
    } catch (e) {
      error.value = 'Network error';
    } finally {
      loading.value = false;
    }
  }

  async function fetchMail(id: number) {
    if (!token.value) return;

    loading.value = true;
    error.value = null;

    try {
      const response = await apiClient.getMail(id);

      if (response.success && response.data) {
        currentMail.value = response.data;
        // Update in list if exists
        const index = mails.value.findIndex(m => m.id === id);
        if (index !== -1) {
          mails.value[index] = response.data;
        }
        return response.data;
      } else {
        error.value = response.message || 'Failed to fetch mail';
        return null;
      }
    } catch (e) {
      error.value = 'Network error';
      return null;
    } finally {
      loading.value = false;
    }
  }

  async function deleteMail(id: number) {
    if (!token.value) return false;

    loading.value = true;
    error.value = null;

    try {
      const response = await apiClient.deleteMail(id);

      if (response.success) {
        mails.value = mails.value.filter(m => m.id !== id);
        if (currentMail.value?.id === id) {
          currentMail.value = null;
        }
        return true;
      } else {
        error.value = response.message || 'Failed to delete mail';
        return false;
      }
    } catch (e) {
      error.value = 'Network error';
      return false;
    } finally {
      loading.value = false;
    }
  }

  function clearAddress() {
    address.value = null;
    token.value = null;
    mails.value = [];
    currentMail.value = null;
    clearToken();
  }

  function restoreSession() {
    const savedToken = getToken();
    const savedAddress = getAddress();
    if (savedToken && savedAddress) {
      token.value = savedToken;
      address.value = savedAddress;
    }
  }

  return {
    // State
    address,
    token,
    mails,
    currentMail,
    loading,
    error,
    pagination,
    // Computed
    hasAddress,
    unreadCount,
    // Actions
    createAddress,
    fetchMails,
    fetchMail,
    deleteMail,
    clearAddress,
    restoreSession,
  };
});
