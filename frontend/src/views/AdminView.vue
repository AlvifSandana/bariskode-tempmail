<template>
  <div class="admin-view">
    <n-card title="Admin Panel">
      <n-alert type="info" style="margin-bottom: 16px">
        Admin panel is under construction. This is a placeholder view.
      </n-alert>

      <n-form :model="formData">
        <n-form-item label="Admin Password">
          <n-input
            v-model:value="formData.password"
            type="password"
            placeholder="Enter admin password"
          />
        </n-form-item>

        <n-button type="primary" @click="handleLogin" :loading="loading">
          Login
        </n-button>
      </n-form>
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import {
  NCard,
  NForm,
  NFormItem,
  NInput,
  NButton,
  NAlert,
  useMessage,
} from 'naive-ui';

const message = useMessage();
const loading = ref(false);
const formData = ref({
  password: '',
});

function handleLogin() {
  loading.value = true;
  
  // Placeholder - actual admin login will be implemented in Phase 5
  setTimeout(() => {
    message.warning('Admin login not implemented yet');
    loading.value = false;
  }, 500);
}
</script>

<style scoped>
.admin-view {
  padding: 24px;
  max-width: 600px;
  margin: 0 auto;
}
</style>
