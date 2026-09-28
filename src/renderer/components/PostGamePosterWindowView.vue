<template>
  <div class="post-game-poster-window">
    <PostGameShareModal
      v-if="poster"
      :poster="poster"
      variant="window"
      @close="hideWindow"
    />
    <div v-else class="post-game-poster-window-empty">
      <span>{{ t('postGame.noRecentGame') }}</span>
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import PostGameShareModal from './PostGameShareModal.vue'
import { electronAPI, hasElectronAPI } from '../native/electron-api.ts'

const { t } = useI18n()
const poster = ref(null)
const windowClass = 'post-game-poster-window-body'
const subscriptions = []

function applyPoster(value) {
  if (value && typeof value === 'object' && value.status !== 'unavailable') {
    poster.value = value
  }
}

async function loadLatestPoster() {
  if (!hasElectronAPI()) return
  try {
    const result = await electronAPI.postGameShare.getLatest()
    applyPoster(result?.data)
  } catch (error) {
    console.warn('Failed to load latest post-game poster:', error)
  }
}

function hideWindow() {
  if (!hasElectronAPI()) return
  void electronAPI.postGameShare.hideWindow()
}

onMounted(() => {
  document.documentElement.classList.add(windowClass)
  document.body.classList.add(windowClass)
  if (hasElectronAPI()) {
    subscriptions.push(electronAPI.events.on('post-game-share-ready', applyPoster))
  }
  void loadLatestPoster()
})

onBeforeUnmount(() => {
  document.documentElement.classList.remove(windowClass)
  document.body.classList.remove(windowClass)
  subscriptions.splice(0).forEach((unsubscribe) => unsubscribe())
})
</script>

<style scoped>
.post-game-poster-window {
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background:
    linear-gradient(180deg, rgba(21, 31, 40, 0.98), rgba(8, 14, 20, 0.98)),
    #0b1016;
  border-radius: 10px;
  outline: 1px solid rgba(255, 255, 255, 0.12);
  outline-offset: -1px;
}

.post-game-poster-window-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(214, 226, 238, 0.6);
  font-size: 13px;
}

:global(html.post-game-poster-window-body),
:global(body.post-game-poster-window-body),
:global(html.post-game-poster-window-body #app) {
  background: transparent !important;
}

:global(body.post-game-poster-window-body) {
  margin: 0;
  overflow: hidden;
}
</style>
