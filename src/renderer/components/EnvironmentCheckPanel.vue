<template>
  <section class="config-card env-check" :class="{ 'has-problems': problemCount > 0 }">
    <div class="card-header env-header">
      <ShieldCheck class="card-icon" />
      <h3 class="card-title">{{ t('environmentCheck.title') }}</h3>
      <button class="env-rerun" type="button" :disabled="loading" :title="t('environmentCheck.rerun')" @click="runCheck">
        <RefreshCw class="env-rerun-icon" :class="{ spinning: loading }" />
        <span>{{ loading ? t('environmentCheck.running') : t('environmentCheck.rerun') }}</span>
      </button>
    </div>

    <button
      v-if="report"
      class="env-summary"
      type="button"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span class="env-dot" :data-status="summaryStatus" aria-hidden="true"></span>
      <span class="env-summary-text">
        {{ problemCount === 0 ? t('environmentCheck.allGood') : t('environmentCheck.summary', { fail: failCount, warn: warnCount }) }}
      </span>
      <ChevronRight class="env-arrow" :class="{ open: expanded }" aria-hidden="true" />
    </button>
    <p v-else-if="error" class="env-error">{{ t('environmentCheck.failed', { error }) }}</p>
    <p v-else class="env-muted">{{ t('environmentCheck.subtitle') }}</p>

    <ul v-if="report && expanded" class="env-list">
      <li v-for="entry in report.items" :key="entry.id" class="env-item" :data-status="entry.status">
        <span class="env-badge">{{ t(`environmentCheck.status.${entry.status}`) }}</span>
        <div class="env-copy">
          <strong>{{ t(`environmentCheck.items.${entry.id}.title`) }}</strong>
          <span>{{ t(`environmentCheck.items.${entry.id}.${entry.variant}`, entry.params) }}</span>
        </div>
      </li>
    </ul>
    <p v-if="report && expanded" class="env-muted env-time">
      {{ t('environmentCheck.checkedAt', { time: new Date(report.checkedAt).toLocaleTimeString() }) }}
    </p>
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ChevronRight, RefreshCw, ShieldCheck } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { electronAPI, hasElectronAPI } from '../native/electron-api.ts'

const { t } = useI18n()
const report = ref(null)
const loading = ref(false)
const error = ref('')
const expanded = ref(false)

const failCount = computed(() => report.value?.items.filter((entry) => entry.status === 'fail').length || 0)
const warnCount = computed(() => report.value?.items.filter((entry) => entry.status === 'warn').length || 0)
const problemCount = computed(() => failCount.value + warnCount.value)
const summaryStatus = computed(() => (failCount.value ? 'fail' : warnCount.value ? 'warn' : 'pass'))

async function runCheck() {
  if (!hasElectronAPI() || loading.value) return
  loading.value = true
  error.value = ''
  try {
    const result = await electronAPI.appInfo.runEnvironmentCheck()
    if (result?.success && result.data) {
      report.value = result.data
      // 有问题就自动展开，全部通过保持收起。
      if (problemCount.value > 0) expanded.value = true
    } else {
      error.value = result?.error || 'unknown error'
    }
  } catch (err) {
    error.value = err?.message || String(err)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void runCheck()
})
</script>

<style scoped>
.env-header {
  display: flex;
  align-items: center;
}

.env-rerun {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
  padding: 4px 8px;
  border: 1px solid rgba(226, 192, 143, 0.22);
  border-radius: 4px;
  background: rgba(7, 18, 27, 0.78);
  color: var(--lol-ivory);
  font-size: 11px;
  cursor: pointer;
}

.env-rerun:disabled {
  cursor: wait;
  opacity: 0.7;
}

.env-rerun-icon {
  width: 13px;
  height: 13px;
}

.spinning {
  animation: env-spin 0.9s linear infinite;
}

@keyframes env-spin {
  to { transform: rotate(360deg); }
}

.env-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 10px;
  border: 1px solid rgba(226, 192, 143, 0.18);
  border-radius: 4px;
  background: rgba(7, 18, 27, 0.5);
  color: var(--lol-ivory);
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}

.env-summary-text {
  flex: 1 1 auto;
  min-width: 0;
}

.env-arrow {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  color: var(--lol-muted);
  transition: transform 0.15s ease;
}

.env-arrow.open {
  transform: rotate(90deg);
}

.env-dot {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 50%;
}

.env-dot[data-status='pass'] { background: var(--lol-success, #4caf7d); }
.env-dot[data-status='warn'] { background: #e2b04a; }
.env-dot[data-status='fail'] { background: #e5534b; }

.env-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.env-item {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 7px 8px;
  border-radius: 4px;
  background: rgba(7, 18, 27, 0.35);
}

.env-badge {
  flex: 0 0 46px;
  padding: 1px 0;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  text-align: center;
  background: rgba(240, 230, 210, 0.08);
  color: var(--lol-muted);
}

.env-item[data-status='pass'] .env-badge { background: rgba(76, 175, 125, 0.16); color: #8fd6a8; }
.env-item[data-status='warn'] .env-badge { background: rgba(226, 176, 74, 0.16); color: #f0c870; }
.env-item[data-status='fail'] .env-badge { background: rgba(229, 83, 75, 0.18); color: #ff8a80; }
.env-item[data-status='info'] .env-badge { background: rgba(96, 161, 176, 0.18); color: #9fe1ef; }

.env-copy {
  min-width: 0;
  overflow-wrap: anywhere;
}

.env-copy strong,
.env-copy span {
  display: block;
}

.env-copy strong {
  color: var(--lol-ivory);
  font-size: 12px;
  font-weight: 700;
}

.env-copy span {
  margin-top: 2px;
  color: var(--lol-muted);
  font-size: 11px;
  line-height: 1.45;
}

.env-muted,
.env-error {
  margin: 0;
  color: var(--lol-muted);
  font-size: 12px;
}

.env-error {
  color: #ff8a80;
}

.env-time {
  margin-top: 8px;
  font-size: 10px;
}
</style>
