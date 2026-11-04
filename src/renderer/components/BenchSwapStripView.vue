<template>
  <div class="strip" :class="{ busy: swappingId != null }">
    <div class="strip-handle" :title="t('teammateAnalysis.stripDrag')">
      <GripVertical class="strip-grip" />
      <span>{{ t('teammateAnalysis.stripTitle') }}</span>
    </div>

    <div class="strip-list">
      <div v-if="current" class="strip-slot current" :title="current.name">
        <img v-if="current.iconUrl" :src="current.iconUrl" :alt="current.name" />
        <span class="strip-rate">{{ percent(current.winRate) }}</span>
        <span class="strip-tag">{{ t('teammateAnalysis.stripCurrent') }}</span>
      </div>
      <button
        v-for="candidate in bench"
        :key="candidate.championId"
        type="button"
        class="strip-slot"
        :class="{ best: candidate.championId === bestId, swapping: swappingId === candidate.championId }"
        :disabled="swappingId != null"
        :title="t('teammateAnalysis.swapTitle', { name: candidate.name })"
        @click="swap(candidate)"
      >
        <img v-if="candidate.iconUrl" :src="candidate.iconUrl" :alt="candidate.name" />
        <span v-else class="strip-fallback">{{ candidate.name }}</span>
        <span class="strip-rate" :class="rateClass(candidate)">{{ percent(candidate.winRate) }}</span>
      </button>
      <span v-if="!bench.length" class="strip-empty">{{ error || t('teammateAnalysis.stripEmpty') }}</span>
    </div>

    <button type="button" class="strip-close" :title="t('teammateAnalysis.stripClose')" @click="closeStrip">
      <X class="strip-close-icon" />
    </button>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { GripVertical, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { electronAPI, hasElectronAPI } from '../native/electron-api.ts'

const { t } = useI18n()
const recommendation = ref(null)
const swappingId = ref(null)
const error = ref('')
const bodyClass = 'bench-swap-strip-body'
let timer = null
let inFlight = false

const candidates = computed(() => recommendation.value?.candidates || [])
const bench = computed(() => candidates.value.filter((candidate) => candidate.source === 'bench'))
const current = computed(() => candidates.value.find((candidate) => candidate.isCurrent) || null)
const bestId = computed(() => {
  const ranked = bench.value.filter((candidate) => Number.isFinite(candidate.winRate))
  if (!ranked.length) return null
  const best = ranked.reduce((a, b) => (b.winRate > a.winRate ? b : a))
  return !current.value || !Number.isFinite(current.value.winRate) || best.winRate > current.value.winRate
    ? best.championId
    : null
})

const percent = (value) => (Number.isFinite(value) && value >= 0 && value <= 1 ? `${(value * 100).toFixed(1)}%` : '—')
const rateClass = (candidate) => {
  const base = current.value?.winRate
  if (!Number.isFinite(candidate.winRate) || !Number.isFinite(base)) return ''
  return candidate.winRate > base ? 'up' : candidate.winRate < base ? 'down' : ''
}

async function refresh() {
  if (!hasElectronAPI() || inFlight) return
  inFlight = true
  try {
    const result = await electronAPI.lcu.getAramBenchRecommendation()
    if (result?.success && result.recommendation) {
      recommendation.value = result.recommendation
      error.value = ''
    }
  } catch (err) {
    error.value = err?.message || String(err)
  } finally {
    inFlight = false
  }
}

async function swap(candidate) {
  if (!hasElectronAPI() || swappingId.value != null) return
  swappingId.value = candidate.championId
  error.value = ''
  try {
    const result = await electronAPI.lcu.benchSwap(candidate.championId)
    if (!result?.success) error.value = t('teammateAnalysis.swapFailed', { error: result?.error || '' })
  } catch (err) {
    error.value = t('teammateAnalysis.swapFailed', { error: err?.message || String(err) })
  } finally {
    swappingId.value = null
    void refresh()
  }
}

function closeStrip() {
  window.close()
}

onMounted(() => {
  document.documentElement.classList.add(bodyClass)
  document.body.classList.add(bodyClass)
  void refresh()
  timer = setInterval(refresh, 1500)
})

onBeforeUnmount(() => {
  clearInterval(timer)
  document.documentElement.classList.remove(bodyClass)
  document.body.classList.remove(bodyClass)
})
</script>

<style scoped>
.strip {
  display: flex;
  align-items: stretch;
  gap: 6px;
  width: 100vw;
  height: 100vh;
  box-sizing: border-box;
  padding: 5px 6px;
  border: 1px solid rgba(200, 170, 110, 0.55);
  border-radius: 6px;
  background: rgba(8, 14, 20, 0.92);
  color: #f0e6d2;
  font-size: 11px;
  user-select: none;
  overflow: hidden;
}

.strip-handle {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  width: 30px;
  flex: 0 0 30px;
  color: #c8aa6e;
  font-weight: 800;
  writing-mode: horizontal-tb;
  cursor: move;
  -webkit-app-region: drag;
}

.strip-handle span {
  font-size: 10px;
  line-height: 1.1;
  text-align: center;
}

.strip-grip {
  width: 16px;
  height: 16px;
}

.strip-list {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.strip-slot {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 0 0 46px;
  width: 46px;
  padding: 0;
  border: 1px solid rgba(240, 230, 210, 0.18);
  border-radius: 4px;
  background: rgba(30, 40, 45, 0.9);
  color: inherit;
  font: inherit;
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.strip-slot img {
  width: 44px;
  height: 44px;
  border-radius: 3px 3px 0 0;
  object-fit: cover;
}

.strip-fallback {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  font-size: 9px;
  overflow: hidden;
}

.strip-slot:hover:not(:disabled) {
  border-color: #c8aa6e;
  box-shadow: 0 0 0 1px #c8aa6e;
}

.strip-slot.best {
  border-color: #f0c860;
  box-shadow: 0 0 6px rgba(240, 200, 96, 0.7);
}

.strip-slot.swapping {
  opacity: 0.5;
}

.strip-slot:disabled {
  cursor: wait;
}

.strip-slot.current {
  cursor: default;
  border-color: rgba(96, 161, 176, 0.7);
  margin-right: 4px;
}

.strip-tag {
  position: absolute;
  top: 1px;
  left: 1px;
  padding: 0 3px;
  border-radius: 2px;
  background: rgba(10, 50, 60, 0.9);
  color: #9fe1ef;
  font-size: 9px;
}

.strip-rate {
  width: 100%;
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.strip-rate.up { color: #8fd694; }
.strip-rate.down { color: #ff8a80; }

.strip-empty {
  color: rgba(240, 230, 210, 0.6);
  white-space: nowrap;
}

.strip-close {
  align-self: flex-start;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: rgba(240, 230, 210, 0.6);
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.strip-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

.strip-close-icon {
  width: 14px;
  height: 14px;
}

:global(html.bench-swap-strip-body),
:global(body.bench-swap-strip-body),
:global(html.bench-swap-strip-body #app) {
  background: transparent !important;
}

:global(body.bench-swap-strip-body) {
  margin: 0;
  overflow: hidden;
}
</style>
