<template>
  <section v-if="visible" class="teammate-panel">
    <header class="teammate-header">
      <div class="teammate-heading">
        <h4>{{ t('teammateAnalysis.title') }}</h4>
        <span v-if="analysis?.fetchCount">{{ t('teammateAnalysis.subtitle', { count: analysis.fetchCount }) }}</span>
      </div>
      <button class="teammate-refresh" type="button" :title="t('teammateAnalysis.retry')" @click="refresh(true)">
        <RefreshCw class="teammate-refresh-icon" :class="{ spinning: loading }" />
      </button>
    </header>

    <p v-if="loading && !players.length" class="teammate-state">{{ t('teammateAnalysis.loading') }}</p>
    <p v-else-if="analysis?.status === 'error'" class="teammate-state error">
      {{ t('teammateAnalysis.failed', { error: analysis.error || '' }) }}
    </p>
    <ul v-else-if="players.length" class="teammate-list">
      <li
        v-for="player in players"
        :key="player.cellId"
        class="teammate-row"
        :class="[`title-${player.title}`, { self: player.isSelf }]"
      >
        <span class="teammate-title">{{ t(`teammateAnalysis.titles.${player.title}`) }}</span>
        <div class="teammate-main">
          <strong class="teammate-name" :title="fullName(player)">{{ displayName(player) }}</strong>
          <span v-if="player.status === 'ok'" class="teammate-stats">
            {{ t('teammateAnalysis.winRate', { value: percent(player.winRate) }) }}
            · {{ t('teammateAnalysis.kda', { value: kda(player.kda) }) }}
            · {{ t('teammateAnalysis.games', { count: player.games }) }}
            <em v-if="player.lowConfidence">{{ t('teammateAnalysis.lowConfidence') }}</em>
          </span>
          <span v-else class="teammate-stats muted">{{ statusText(player) }}</span>
        </div>
        <span class="teammate-score">{{ player.score != null ? player.score.toFixed(1) : '--' }}</span>
      </li>
    </ul>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RefreshCw } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { electronAPI, hasElectronAPI } from '../native/electron-api.ts'

const props = defineProps({
  // 由席位推荐面板传入：只在选人阶段查询和显示。
  active: { type: Boolean, default: false },
})

const { t } = useI18n()
const analysis = ref(null)
const loading = ref(false)
const enabled = ref(true)
const unsubscribe = []
let inFlight = false
let pollTimer = null

const players = computed(() => analysis.value?.players || [])
const visible = computed(() => enabled.value && props.active)

const refresh = async (force = false) => {
  if (!hasElectronAPI() || typeof electronAPI.lcu?.getTeammateAnalysis !== 'function') return
  if (inFlight || (!force && !visible.value)) return
  inFlight = true
  loading.value = true
  try {
    const result = await electronAPI.lcu.getTeammateAnalysis()
    analysis.value = result?.analysis || null
    if (analysis.value?.status === 'disabled') enabled.value = false
  } catch (error) {
    analysis.value = { status: 'error', error: error?.message || String(error), players: [] }
  } finally {
    inFlight = false
    loading.value = false
  }
}

// 主进程按对局缓存结果，这里低频轮询只为在进入选人后尽快拿到数据，拿到即停。
const schedulePoll = () => {
  clearTimeout(pollTimer)
  pollTimer = setTimeout(async () => {
    if (visible.value && analysis.value?.status !== 'ready') {
      await refresh()
    }
    if (visible.value && analysis.value?.status !== 'ready') schedulePoll()
  }, 4000)
}

const displayName = (player) => {
  if (player.isSelf) return t('teammateAnalysis.you')
  return player.gameName || (player.status === 'hidden' ? t('teammateAnalysis.anonymous') : t('teammateAnalysis.floor', { floor: player.floor }))
}
const fullName = (player) => player.gameName ? `${player.gameName}${player.tagLine ? `#${player.tagLine}` : ''}` : ''
const percent = (value) => Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : '--'
const kda = (value) => Number.isFinite(value) ? (value >= 99 ? 'Perfect' : value.toFixed(2)) : '--'
const statusText = (player) => {
  if (player.status === 'hidden') return t('teammateAnalysis.hidden')
  if (player.status === 'error') return t('teammateAnalysis.queryError')
  return t('teammateAnalysis.noGames')
}

onMounted(async () => {
  if (!hasElectronAPI()) return
  try {
    enabled.value = (await electronAPI.store?.get?.('aram.teammateAnalysis')) !== false
  } catch {
    enabled.value = true
  }
  unsubscribe.push(electronAPI.events.on('aram-preferences-changed', (payload) => {
    if (payload?.key === 'aram.teammateAnalysis') {
      enabled.value = payload.value
      if (payload.value) refresh(true)
    }
  }))
  unsubscribe.push(electronAPI.events.on('game-phase-changed', () => {
    analysis.value = null
    refresh().then(schedulePoll)
  }))
  refresh().then(schedulePoll)
})

onBeforeUnmount(() => {
  clearTimeout(pollTimer)
  unsubscribe.splice(0).forEach((off) => off?.())
})

defineExpose({ refresh })
</script>

<style scoped>
.teammate-panel {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(244, 236, 220, 0.08);
}

.teammate-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.teammate-heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.teammate-heading h4 {
  margin: 0;
  color: var(--lol-gold-2, #e2c27a);
  font-size: 12px;
  font-weight: 800;
}

.teammate-heading span {
  color: var(--lol-muted, #a99f8c);
  font-size: 11px;
}

.teammate-refresh {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 1px solid rgba(244, 236, 220, 0.12);
  border-radius: 4px;
  color: var(--lol-muted, #a99f8c);
  background: transparent;
  cursor: pointer;
}

.teammate-refresh-icon {
  width: 13px;
  height: 13px;
}

.spinning {
  animation: teammate-spin 0.9s linear infinite;
}

@keyframes teammate-spin {
  to { transform: rotate(360deg); }
}

.teammate-state {
  margin: 4px 0;
  color: var(--lol-muted, #a99f8c);
  font-size: 12px;
}

.teammate-state.error {
  color: var(--lol-danger, #ffb4ab);
}

.teammate-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.teammate-row {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: 1px solid rgba(244, 236, 220, 0.06);
  border-radius: 4px;
  background: rgba(7, 18, 27, 0.5);
}

.teammate-row.self {
  border-color: rgba(226, 192, 143, 0.35);
}

.teammate-title {
  font-size: 12px;
  font-weight: 800;
  white-space: nowrap;
}

.title-ace .teammate-title { color: #f6d365; }
.title-high .teammate-title { color: #8fd694; }
.title-mid .teammate-title { color: #d7e4f1; }
.title-low .teammate-title { color: #e0a96d; }
.title-burden .teammate-title { color: #ff8a80; }
.title-newbie .teammate-title { color: var(--lol-muted, #a99f8c); }

.teammate-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.teammate-name {
  overflow: hidden;
  color: var(--lol-ivory, #f4ecdc);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.teammate-stats {
  color: #b8c4cf;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.teammate-stats.muted {
  color: var(--lol-muted, #a99f8c);
}

.teammate-stats em {
  margin-left: 4px;
  color: var(--lol-faint, #6f7a82);
  font-style: normal;
}

.teammate-score {
  color: var(--lol-gold-2, #e2c27a);
  font-size: 15px;
  font-weight: 900;
  font-variant-numeric: tabular-nums;
}
</style>
