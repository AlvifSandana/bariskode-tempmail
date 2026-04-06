import { defineStore } from 'pinia';
import { ref } from 'vue';
import { apiClient } from '@/api';
import type { Settings } from '@/api';

export const useSettingsStore = defineStore('settings', () => {
  // State
  const settings = ref<Settings | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  // Actions
  async function fetchSettings() {
    loading.value = true;
    error.value = null;

    try {
      const response = await apiClient.getSettings();

      if (response.success && response.data) {
        settings.value = response.data;
      } else {
        error.value = response.message || 'Failed to fetch settings';
      }
    } catch (e) {
      error.value = 'Network error';
    } finally {
      loading.value = false;
    }
  }

  return {
    // State
    settings,
    loading,
    error,
    // Actions
    fetchSettings,
  };
});
