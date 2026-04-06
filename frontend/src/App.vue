<template>
  <n-config-provider :theme="darkMode ? darkTheme : undefined">
    <n-message-provider>
      <n-dialog-provider>
        <router-view />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { ref, provide } from 'vue'
import { 
  NConfigProvider, 
  NMessageProvider, 
  NDialogProvider,
  darkTheme 
} from 'naive-ui'

const darkMode = ref(true)
provide('darkMode', darkMode)
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen,
    Ubuntu, Cantarell, 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

#app {
  min-height: 100vh;
  background-color: #1a1a1a;
}
</style>
