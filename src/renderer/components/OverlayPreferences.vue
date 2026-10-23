<template>
  <section class="config-card">
    <div class="card-header">
      <Settings class="setting-icon" />
      <h3 class="card-title">{{ t('preferences.title') }}</h3>
    </div>

    <div class="overlay-mode-hint">
      <AlertTriangle class="hint-icon" />
      <div class="hint-copy">
        <strong>{{ t('preferences.fullscreenTitle') }}</strong>
        <span>{{ t('preferences.fullscreenDescription') }}</span>
      </div>
    </div>

    <div class="card-content">
      <div
        v-for="item in preferenceItems"
        :key="item.key"
        class="setting-row"
      >
        <div class="setting-copy">
          <strong>{{ item.title }}</strong>
          <span>{{ item.description }}</span>
        </div>

        <button
          class="switch-control"
          type="button"
          role="switch"
          :aria-label="item.title"
          :aria-checked="String(preferences[item.key])"
          :class="{ active: preferences[item.key] }"
          :disabled="savingKey === item.key"
          @click="togglePreference(item.key)"
        >
          <span class="switch-thumb"></span>
        </button>
      </div>

      <div class="setting-row">
        <div class="setting-copy">
          <strong>{{ t('preferences.highlightModeTitle') }}</strong>
          <span>{{ t(`preferences.highlightModeHints.${highlightMode}`) }}</span>
        </div>

        <Select
          :model-value="highlightMode"
          :disabled="highlightModeSaving"
          @update:model-value="changeHighlightMode"
        >
          <SelectTrigger
            class="highlight-mode-trigger"
            :aria-label="t('preferences.highlightModeTitle')"
            :title="t('preferences.highlightModeDescription')"
          >
            <SelectValue>{{ t(`preferences.highlightModes.${highlightMode}`) }}</SelectValue>
          </SelectTrigger>
          <SelectContent align="end" :side-offset="6">
            <SelectItem
              v-for="mode in AUGMENT_HIGHLIGHT_MODES"
              :key="mode"
              :value="mode"
              :text-value="t(`preferences.highlightModes.${mode}`)"
            >
              {{ t(`preferences.highlightModes.${mode}`) }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { AlertTriangle, Settings } from 'lucide-vue-next'
import { electronAPI, hasElectronAPI } from '../native/electron-api.ts'
import { useI18n } from 'vue-i18n'
import {
  AUGMENT_HIGHLIGHT_MODES,
  AUGMENT_HIGHLIGHT_MODE_STORE_KEY,
  DEFAULT_AUGMENT_HIGHLIGHT_MODE,
  isAugmentHighlightMode,
  normalizeAugmentHighlightMode,
} from '../../shared/augment-highlight.ts'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select/index.js'

const { t } = useI18n()
const emit = defineEmits(['post-game-auto-show-changed', 'post-game-popup-window-changed'])
const preferenceDefinitions = [
  {
    key: 'showChampionDetails',
    storeKey: 'championInsight.showDetails',
    defaultValue: true,
    titleKey: 'preferences.championDetailsTitle',
    descriptionKey: 'preferences.championDetailsDescription',
  },
  {
    key: 'hideChampionInsightOnGameStart',
    storeKey: 'championInsight.hideOnGameStart',
    defaultValue: true,
    titleKey: 'preferences.hideDetailsTitle',
    descriptionKey: 'preferences.hideDetailsDescription',
  },
  {
    key: 'championInsightAlwaysOnTop',
    storeKey: 'championInsight.alwaysOnTop',
    defaultValue: false,
    titleKey: 'preferences.alwaysOnTopTitle',
    descriptionKey: 'preferences.alwaysOnTopDescription',
  },
  {
    key: 'showAugmentTopOverlay',
    storeKey: 'augments.showTopOverlay',
    defaultValue: true,
    titleKey: 'preferences.topOverlayTitle',
    descriptionKey: 'preferences.topOverlayDescription',
  },
  {
    key: 'showAugmentSidePanel',
    storeKey: 'augments.showSidePanel',
    defaultValue: true,
    titleKey: 'preferences.sidePanelTitle',
    descriptionKey: 'preferences.sidePanelDescription',
  },
  {
    key: 'autoShowPostGameShare',
    storeKey: 'postGameShare.autoShow',
    defaultValue: true,
    titleKey: 'preferences.postGameShareTitle',
    descriptionKey: 'preferences.postGameShareDescription',
  },
  {
    key: 'postGameSharePopupWindow',
    storeKey: 'postGameShare.popupWindow',
    defaultValue: true,
    titleKey: 'preferences.postGamePopupTitle',
    descriptionKey: 'preferences.postGamePopupDescription',
  },
]

const preferenceItems = computed(() => preferenceDefinitions.map(item => ({
  ...item,
  title: t(item.titleKey),
  description: t(item.descriptionKey),
})))

const preferences = reactive(
  preferenceDefinitions.reduce((result, item) => {
    result[item.key] = item.defaultValue
    return result
  }, {})
)
const savingKey = ref('')
const itemByKey = new Map(preferenceDefinitions.map(item => [item.key, item]))

const loadPreferences = async () => {
  if (!hasElectronAPI()) {
    return
  }

  for (const item of preferenceDefinitions) {
    try {
      const storedValue = await electronAPI.store.get(item.storeKey)
      if (storedValue == null) {
        await electronAPI.store.set(item.storeKey, item.defaultValue)
        preferences[item.key] = item.defaultValue
        continue
      }

      preferences[item.key] = Boolean(storedValue)
      if (item.key === 'autoShowPostGameShare') {
        emit('post-game-auto-show-changed', preferences[item.key])
      }
      if (item.key === 'postGameSharePopupWindow') {
        emit('post-game-popup-window-changed', preferences[item.key])
      }
    } catch (error) {
      console.warn('读取窗口偏好失败:', item.storeKey, error)
    }
  }
}

const applyImmediateWindowEffect = (key, value) => {
  if (value) {
    return
  }

  if (key === 'showAugmentTopOverlay') {
    electronAPI.windows.hideFloating()
  } else if (key === 'showAugmentSidePanel') {
    electronAPI.windows.hideAugmentSidePanel()
  } else if (key === 'showChampionDetails') {
    electronAPI.windows.hidePopup()
  }
}

const togglePreference = async (key) => {
  const item = itemByKey.get(key)
  if (!item) {
    return
  }

  const nextValue = !preferences[key]
  if (!hasElectronAPI()) {
    preferences[key] = nextValue
    return
  }

  savingKey.value = key
  try {
    await electronAPI.store.set(item.storeKey, nextValue)
    preferences[key] = nextValue
    applyImmediateWindowEffect(key, nextValue)
    if (key === 'autoShowPostGameShare') {
      emit('post-game-auto-show-changed', nextValue)
    }
  } catch (error) {
    console.warn('保存窗口偏好失败:', item.storeKey, error)
  } finally {
    savingKey.value = ''
  }
}

const highlightMode = ref(DEFAULT_AUGMENT_HIGHLIGHT_MODE)
const highlightModeSaving = ref(false)

const loadHighlightMode = async () => {
  if (!hasElectronAPI()) {
    return
  }

  try {
    highlightMode.value = normalizeAugmentHighlightMode(
      await electronAPI.store.get(AUGMENT_HIGHLIGHT_MODE_STORE_KEY)
    )
  } catch (error) {
    console.warn('读取高亮计算方式失败:', error)
  }
}

const changeHighlightMode = async (mode) => {
  if (!isAugmentHighlightMode(mode) || mode === highlightMode.value) {
    return
  }

  const previousMode = highlightMode.value
  highlightMode.value = mode
  if (!hasElectronAPI()) {
    return
  }

  highlightModeSaving.value = true
  try {
    await electronAPI.store.set(AUGMENT_HIGHLIGHT_MODE_STORE_KEY, mode)
  } catch (error) {
    highlightMode.value = previousMode
    console.warn('保存高亮计算方式失败:', error)
  } finally {
    highlightModeSaving.value = false
  }
}

onMounted(() => {
  loadPreferences()
  loadHighlightMode()
})
</script>

<style scoped>
.config-card {
  height: auto;
  flex: 0 0 auto;
  background:
    linear-gradient(145deg, rgba(31, 43, 53, 0.62), rgba(7, 10, 13, 0.34));
  border: 1px solid var(--lol-border-soft);
  border-radius: 4px;
  padding: 14px;
  overflow: hidden;
  color: var(--lol-ivory);
  box-shadow: inset 0 0 18px rgba(194, 156, 109, 0.04);
}

.card-header,
.setting-row {
  display: flex;
  align-items: center;
}

.card-header {
  gap: 10px;
  padding: 0 0 12px;
}

.setting-icon {
  width: 16px;
  height: 16px;
  color: var(--lol-gold-2);
}

.card-title {
  margin: 0;
  color: var(--lol-gold-2);
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 0;
  text-transform: uppercase;
}

.card-content {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.overlay-mode-hint {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  margin: 0 0 14px;
  padding: 9px 10px;
  border: 1px solid rgba(226, 192, 143, 0.18);
  border-radius: 4px;
  background: rgba(226, 192, 143, 0.08);
}

.hint-icon {
  width: 15px;
  height: 15px;
  flex: 0 0 auto;
  margin-top: 1px;
  color: #e2c08f;
}

.hint-copy {
  min-width: 0;
}

.hint-copy strong,
.hint-copy span {
  display: block;
}

.hint-copy strong {
  color: #e2c08f;
  font-size: 12px;
  font-weight: 900;
  line-height: 1.25;
}

.hint-copy span {
  margin-top: 4px;
  color: var(--lol-muted);
  font-size: 11px;
  font-weight: 700;
  line-height: 1.45;
}

.setting-row {
  justify-content: space-between;
  gap: 14px;
}

.setting-copy {
  min-width: 0;
}

.setting-copy strong {
  display: block;
  color: var(--lol-ivory);
  font-size: 13px;
  font-weight: 900;
  line-height: 1.25;
}

.setting-copy span {
  display: block;
  margin-top: 5px;
  color: var(--lol-muted);
  font-size: 11px;
  font-weight: 700;
  line-height: 1.45;
}

.highlight-mode-trigger {
  width: 112px;
  height: 32px;
  flex: 0 0 auto;
  padding: 0 10px;
  border-radius: 4px;
  color: var(--lol-ivory);
  background: rgba(7, 18, 27, 0.78) !important;
  border-color: rgba(226, 192, 143, 0.22) !important;
}

.switch-control {
  position: relative;
  width: 42px;
  height: 24px;
  flex: 0 0 auto;
  padding: 2px;
  border: 1px solid rgba(244, 236, 220, 0.12);
  border-radius: 999px;
  background: rgba(4, 15, 24, 0.64);
  cursor: pointer;
  transition: border-color 0.18s ease, background 0.18s ease, transform 0.15s ease-out;
}

.switch-control::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 42px;
  height: 40px;
  transform: translate(-50%, -50%);
}

.switch-control:active:not(:disabled) {
  transform: scale(0.96);
}

.switch-control.active {
  border-color: rgba(226, 192, 143, 0.44);
  background: rgba(194, 156, 109, 0.32);
}

.switch-control:disabled {
  opacity: 0.6;
  cursor: wait;
}

.switch-thumb {
  display: block;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #bacac6;
  transition: transform 0.18s ease, background 0.18s ease;
}

.switch-control.active .switch-thumb {
  transform: translateX(18px);
  background: #f4ecdc;
}
</style>
