<template>
  <div class="user-view">
    <n-card title="User Account">
      <n-alert type="info" style="margin-bottom: 16px">
        User account features are under construction.
      </n-alert>

      <n-tabs>
        <n-tab-pane name="login" tab="Login">
          <n-form :model="loginForm">
            <n-form-item label="Email">
              <n-input v-model:value="loginForm.email" placeholder="Enter email" />
            </n-form-item>
            <n-form-item label="Password">
              <n-input v-model:value="loginForm.password" type="password" placeholder="Enter password" />
            </n-form-item>
            <n-button type="primary">Login</n-button>
          </n-form>
        </n-tab-pane>

        <n-tab-pane name="register" tab="Register">
          <n-form :model="registerForm">
            <n-form-item label="Email">
              <n-input v-model:value="registerForm.email" placeholder="Enter email" />
            </n-form-item>
            <n-form-item label="Password">
              <n-input v-model:value="registerForm.password" type="password" placeholder="Enter password" />
            </n-form-item>
            <n-form-item label="Confirm">
              <n-input v-model:value="registerForm.confirmPassword" type="password" placeholder="Confirm password" />
            </n-form-item>
            <n-button type="primary">Register</n-button>
          </n-form>
        </n-tab-pane>
      </n-tabs>
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import {
  NCard,
  NTabs,
  NTabPane,
  NForm,
  NFormItem,
  NInput,
  NButton,
  NAlert,
} from 'naive-ui';

const loginForm = ref({
  email: '',
  password: '',
});

const registerForm = ref({
  email: '',
  password: '',
  confirmPassword: '',
});
</script>

<style scoped>
.user-view {
  padding: 24px;
  max-width: 600px;
  margin: 0 auto;
}
</style>
