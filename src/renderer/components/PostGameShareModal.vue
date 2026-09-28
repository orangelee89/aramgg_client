<template>
  <div class="post-share-overlay" :class="{ 'post-share-overlay-window': variant === 'window' }" @click.self="emit('close')">
    <section class="post-share-modal" role="dialog" aria-modal="true" aria-labelledby="post-share-title">
      <header class="post-share-header">
        <div>
          <p class="post-share-kicker">{{ t('postGame.kicker') }}</p>
          <h2 id="post-share-title">{{ t('postGame.title') }}</h2>
        </div>
        <button class="post-share-icon-button" type="button" :title="t('common.close')" @click="emit('close')">
          <X class="post-share-icon" />
        </button>
      </header>

      <div class="post-share-preview">
        <canvas
          ref="canvasRef"
          class="post-share-canvas"
          :width="POSTER_WIDTH"
          :height="posterHeight"
        ></canvas>
      </div>

      <section v-if="comparePlayers.length > 0" class="post-share-compare">
        <div class="post-share-compare-header">
          <span class="post-share-compare-title">{{ t('postGame.damageCompare') }}</span>
          <span class="post-share-compare-hint">{{ t('postGame.damageCompareHint') }}</span>
        </div>
        <div class="post-share-compare-list">
          <template v-for="group in comparePlayerGroups" :key="group.key">
            <p class="post-share-compare-group">{{ group.label }}</p>
            <label
              v-for="player in group.players"
              :key="player.key"
              class="post-share-compare-row"
              :class="{ pinned: isPinnedPlayer(player) }"
            >
              <input
                type="checkbox"
                class="post-share-compare-checkbox"
                :checked="isSelectedPlayer(player)"
                @change="togglePlayer(player)"
              />
              <span class="post-share-compare-champion">{{ player.champion?.name || t('postGame.championFallback') }}</span>
              <span class="post-share-compare-summoner">{{ player.summonerName }}</span>
              <button
                type="button"
                class="post-share-pin"
                :class="{ active: isPinnedPlayer(player) }"
                :title="t('postGame.pinPlayer')"
                @click.prevent="togglePinnedPlayer(player)"
              >
                <Pin class="post-share-pin-icon" />
              </button>
            </label>
          </template>
        </div>
      </section>

      <div class="post-share-actions">
        <button
          class="post-share-action"
          type="button"
          :title="t('postGame.copyTitle')"
          :disabled="actionPending"
          @click="copyPoster"
        >
          <Copy class="post-share-action-icon" />
          <span>{{ t('postGame.copy') }}</span>
        </button>
        <button
          class="post-share-action accent"
          type="button"
          :title="t('postGame.saveTitle')"
          :disabled="actionPending"
          @click="savePoster"
        >
          <Download class="post-share-action-icon" />
          <span>{{ t('postGame.save') }}</span>
        </button>
      </div>
    </section>

    <Transition name="post-share-toast">
      <div v-if="toast.visible" class="post-share-toast" :class="toast.type" role="status">
        <CheckCircle2 v-if="toast.type === 'success'" class="post-share-toast-icon" />
        <CircleAlert v-else class="post-share-toast-icon" />
        <span>{{ toast.message }}</span>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CheckCircle2, CircleAlert, Copy, Download, Pin, X } from 'lucide-vue-next'
import { electronAPI } from '../native/electron-api.ts'
import { trackAnalyticsEvent } from '../services/analytics.ts'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  poster: {
    type: Object,
    required: true,
  },
  variant: {
    type: String,
    default: 'modal',
  },
})
const variant = props.variant

const emit = defineEmits(['close'])
const { t, locale } = useI18n()

const POSTER_WIDTH = 750
const POSTER_HEIGHT = 1334
const FONT_FAMILY = '"Microsoft YaHei", "Segoe UI", Arial, sans-serif'

const canvasRef = ref(null)
const actionPending = ref(false)
const toast = ref({
  visible: false,
  message: '',
  type: 'success',
})
let drawToken = 0
let toastTimer = null

// 伤害对比：勾选本局其他玩家后，海报在经济/KDA 下方插入输出/承伤柱状图；
// "固定"的玩家名存到 postGameShare.comparePlayers，以后同一个人在局里就自动勾上。
const COMPARE_STORE_KEY = 'postGameShare.comparePlayers'
// 称号面板：标题 + 鎏金称号占 118px，之后每个殊荣一行描述。
const TITLE_PANEL_BASE_HEIGHT = 118
const TITLE_PANEL_LINE_HEIGHT = 24
const TITLE_PANEL_GAP = 22
const CHART_TOP = 774
const CHART_HEADER_HEIGHT = 54
const CHART_ROW_HEIGHT = 92
const CHART_BOTTOM_PADDING = 18
const CHART_SECTION_GAP = 22
const selectedPlayerKeys = ref([])
const pinnedPlayerNames = ref([])

function normalizePlayerName(value) {
  return String(value || '')
    .split('#')[0]
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim()
}

function hasDamageStats(player) {
  const stats = player?.stats || {}
  return safeNumber(stats.damageDealtToChampions) != null || safeNumber(stats.damageTaken) != null
}

const posterPlayers = computed(() => Array.isArray(props.poster?.players) ? props.poster.players : [])
const selfPlayer = computed(() => posterPlayers.value.find((player) => player?.isSelf) || null)
const comparePlayers = computed(() =>
  posterPlayers.value.filter((player) => player && !player.isSelf && player.key && hasDamageStats(player))
)
const comparePlayerGroups = computed(() => {
  const selfTeam = selfPlayer.value?.team || ''
  const allies = comparePlayers.value.filter((player) => !selfTeam || player.team === selfTeam)
  const enemies = comparePlayers.value.filter((player) => selfTeam && player.team && player.team !== selfTeam)
  const groups = []
  if (allies.length) groups.push({ key: 'ally', label: t('postGame.teamAlly'), players: allies })
  if (enemies.length) groups.push({ key: 'enemy', label: t('postGame.teamEnemy'), players: enemies })
  return groups
})
const chartPlayers = computed(() => {
  const selected = comparePlayers.value.filter((player) => selectedPlayerKeys.value.includes(player.key))
  if (!selected.length) return []
  const poster = props.poster || {}
  const self = {
    key: selfPlayer.value?.key || 'self',
    summonerName: poster.summonerName || selfPlayer.value?.summonerName || '',
    champion: poster.champion || selfPlayer.value?.champion || null,
    stats: poster.stats || selfPlayer.value?.stats || {},
    rating: poster.rating || selfPlayer.value?.rating || null,
    isSelf: true,
  }
  return [self, ...selected]
})
const chartHeight = computed(() =>
  chartPlayers.value.length > 1
    ? CHART_HEADER_HEIGHT + chartPlayers.value.length * CHART_ROW_HEIGHT + CHART_BOTTOM_PADDING
    : 0
)
const titleShift = computed(() => props.poster?.rating ? getHorseTitlePanelHeight(props.poster.rating) + TITLE_PANEL_GAP : 0)
const chartShift = computed(() => chartHeight.value > 0 ? chartHeight.value + CHART_SECTION_GAP : 0)
const layoutShift = computed(() => titleShift.value + chartShift.value)
const posterHeight = computed(() => POSTER_HEIGHT + layoutShift.value)

function isSelectedPlayer(player) {
  return selectedPlayerKeys.value.includes(player.key)
}

function isPinnedPlayer(player) {
  const name = normalizePlayerName(player?.summonerName)
  return Boolean(name) && pinnedPlayerNames.value.includes(name)
}

function togglePlayer(player) {
  if (isSelectedPlayer(player)) {
    selectedPlayerKeys.value = selectedPlayerKeys.value.filter((key) => key !== player.key)
  } else {
    selectedPlayerKeys.value = [...selectedPlayerKeys.value, player.key]
  }
}

async function savePinnedPlayers() {
  try {
    await electronAPI.store.set(COMPARE_STORE_KEY, [...pinnedPlayerNames.value])
  } catch (error) {
    console.warn('Failed to save pinned compare players:', error)
  }
}

function togglePinnedPlayer(player) {
  const name = normalizePlayerName(player?.summonerName)
  if (!name) return
  if (pinnedPlayerNames.value.includes(name)) {
    pinnedPlayerNames.value = pinnedPlayerNames.value.filter((item) => item !== name)
  } else {
    pinnedPlayerNames.value = [...pinnedPlayerNames.value, name]
    if (!isSelectedPlayer(player)) {
      selectedPlayerKeys.value = [...selectedPlayerKeys.value, player.key]
    }
  }
  void savePinnedPlayers()
}

function syncSelectedPlayers() {
  const available = new Set(comparePlayers.value.map((player) => player.key))
  const kept = selectedPlayerKeys.value.filter((key) => available.has(key))
  const autoSelected = comparePlayers.value
    .filter((player) => isPinnedPlayer(player) && !kept.includes(player.key))
    .map((player) => player.key)
  selectedPlayerKeys.value = [...kept, ...autoSelected]
}

async function loadPinnedPlayers() {
  try {
    const stored = await electronAPI.store.get(COMPARE_STORE_KEY)
    pinnedPlayerNames.value = Array.isArray(stored)
      ? stored.map(normalizePlayerName).filter(Boolean)
      : []
  } catch (error) {
    console.warn('Failed to load pinned compare players:', error)
    pinnedPlayerNames.value = []
  }
  syncSelectedPlayers()
}

const resultLabel = computed(() => {
  if (props.poster?.result === 'victory') return t('postGame.victory')
  if (props.poster?.result === 'defeat') return t('postGame.defeat')
  return t('postGame.result')
})

const resultColor = computed(() => {
  if (props.poster?.result === 'victory') return '#35d6b2'
  if (props.poster?.result === 'defeat') return '#ff6b6b'
  return '#e2c08f'
})

function buildChampionDisplayName(champion) {
  const name = String(champion?.name || '').trim()
  const title = String(champion?.title || '').trim()

  if (!name && !title) return t('postGame.championFallback')
  if (!name) return title
  if (!title || title === name || title.includes(name)) return name
  return `${title} ${name}`
}

const championName = computed(() => buildChampionDisplayName(props.poster?.champion))

function hasPosterStats(poster) {
  const stats = poster?.stats
  if (!stats) return false

  return [stats.kills, stats.deaths, stats.assists].every((value) => {
    if (value == null) return false
    if (typeof value === 'string' && !value.trim()) return false
    return Number.isFinite(Number(value))
  })
}

function getPosterAnalyticsParams(extra = {}) {
  const poster = props.poster || {}
  return {
    status: poster.status || 'unknown',
    result: poster.result || 'unknown',
    champion_id: poster.champion?.id ?? null,
    augment_count: Array.isArray(poster.augments) ? poster.augments.length : 0,
    has_stats: hasPosterStats(poster),
    ...extra,
  }
}

function trackPostGameShareEvent(name, params = {}) {
  try {
    trackAnalyticsEvent(name, getPosterAnalyticsParams(params))
  } catch (error) {
    console.warn('Failed to track post-game share event:', error)
  }
}

function safeNumber(value) {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

function formatLargeNumber(value) {
  const numberValue = safeNumber(value)
  if (numberValue == null) return '-'
  if (Math.abs(numberValue) >= 1000) {
    return `${(numberValue / 1000).toFixed(numberValue >= 10000 ? 1 : 2).replace(/\.0+$/, '')}K`
  }
  return String(Math.round(numberValue))
}

function formatKdaValue(value) {
  const numberValue = safeNumber(value)
  if (numberValue == null) return '-'
  return numberValue.toFixed(2)
}

function formatDuration(seconds) {
  const numberValue = safeNumber(seconds)
  if (numberValue == null || numberValue <= 0) return 'ARAM'
  const minutes = Math.floor(numberValue / 60)
  const rest = Math.round(numberValue % 60)
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

function getKdaParts() {
  const stats = props.poster?.stats || {}
  return [
    safeNumber(stats.kills),
    safeNumber(stats.deaths),
    safeNumber(stats.assists),
  ].map((value) => value == null ? '-' : String(Math.round(value)))
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

function fillRoundedRect(ctx, x, y, width, height, radius, fillStyle) {
  drawRoundedRect(ctx, x, y, width, height, radius)
  ctx.fillStyle = fillStyle
  ctx.fill()
}

function strokeRoundedRect(ctx, x, y, width, height, radius, strokeStyle, lineWidth = 1) {
  drawRoundedRect(ctx, x, y, width, height, radius)
  ctx.strokeStyle = strokeStyle
  ctx.lineWidth = lineWidth
  ctx.stroke()
}

function drawText(ctx, text, x, y, options = {}) {
  const {
    size = 28,
    weight = 500,
    color = '#f6fbff',
    align = 'left',
    baseline = 'alphabetic',
    maxWidth = null,
  } = options
  ctx.font = `${weight} ${size}px ${FONT_FAMILY}`
  ctx.fillStyle = color
  ctx.textAlign = align
  ctx.textBaseline = baseline

  let output = String(text || '')
  if (maxWidth && ctx.measureText(output).width > maxWidth) {
    while (output.length > 1 && ctx.measureText(`${output}...`).width > maxWidth) {
      output = output.slice(0, -1)
    }
    output = `${output}...`
  }
  ctx.fillText(output, x, y)
}

function drawHexIcon(ctx, x, y, radius, fillStyle, strokeStyle) {
  ctx.beginPath()
  for (let index = 0; index < 6; index += 1) {
    const angle = Math.PI / 6 + index * Math.PI / 3
    const px = x + Math.cos(angle) * radius
    const py = y + Math.sin(angle) * radius
    if (index === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
  ctx.fillStyle = fillStyle
  ctx.fill()
  ctx.strokeStyle = strokeStyle
  ctx.lineWidth = 3
  ctx.stroke()
}

function loadImage(src) {
  if (!src) return Promise.resolve(null)
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = src
  })
}

function drawCircularImage(ctx, image, x, y, radius, fallbackText) {
  ctx.save()
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.closePath()
  ctx.clip()

  if (image) {
    const size = Math.min(image.width, image.height)
    const sx = Math.max(0, (image.width - size) / 2)
    const sy = Math.max(0, (image.height - size) / 2)
    ctx.drawImage(image, sx, sy, size, size, x - radius, y - radius, radius * 2, radius * 2)
  } else {
    const fallbackGradient = ctx.createLinearGradient(x - radius, y - radius, x + radius, y + radius)
    fallbackGradient.addColorStop(0, '#203040')
    fallbackGradient.addColorStop(1, '#c8573f')
    ctx.fillStyle = fallbackGradient
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2)
    drawText(ctx, fallbackText.slice(0, 2), x, y + Math.round(radius * 0.2), {
      size: Math.round(radius * 0.84),
      weight: 800,
      color: '#ffffff',
      align: 'center',
      baseline: 'middle',
    })
  }

  ctx.restore()
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)'
  ctx.lineWidth = 3
  ctx.stroke()
}

function drawBackground(ctx, height = POSTER_HEIGHT) {
  const gradient = ctx.createLinearGradient(0, 0, POSTER_WIDTH, height)
  gradient.addColorStop(0, '#121a22')
  gradient.addColorStop(0.5, '#0b1016')
  gradient.addColorStop(1, '#191b20')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, POSTER_WIDTH, height)

  const glow = ctx.createRadialGradient(140, 110, 0, 140, 110, 460)
  glow.addColorStop(0, 'rgba(41, 210, 188, 0.25)')
  glow.addColorStop(1, 'rgba(41, 210, 188, 0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, POSTER_WIDTH, height)

  const ember = ctx.createRadialGradient(690, 310, 0, 690, 310, 420)
  ember.addColorStop(0, 'rgba(232, 100, 64, 0.28)')
  ember.addColorStop(1, 'rgba(232, 100, 64, 0)')
  ctx.fillStyle = ember
  ctx.fillRect(0, 0, POSTER_WIDTH, height)

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)'
  ctx.lineWidth = 1
  for (let x = 60; x < POSTER_WIDTH; x += 70) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x - 260, height)
    ctx.stroke()
  }
}

function drawDamageBar(ctx, x, y, width, height, ratio, color, label) {
  fillRoundedRect(ctx, x, y, width, height, height / 2, 'rgba(255, 255, 255, 0.08)')
  const barWidth = Math.max(height, Math.round(width * Math.max(0, Math.min(1, ratio))))
  fillRoundedRect(ctx, x, y, barWidth, height, height / 2, color)
  drawText(ctx, label, x + width + 12, y + height / 2, {
    size: 18,
    weight: 800,
    color,
    baseline: 'middle',
  })
}

/**
 * 输出/承伤对比：每个玩家一行，左侧头像+名字，右侧两条水平柱（输出、承伤），
 * 以所有参与对比玩家的最大值为满刻度。
 */
function drawDamageCompare(ctx, top, players, images) {
  const x = 52
  const width = 646
  const height = CHART_HEADER_HEIGHT + players.length * CHART_ROW_HEIGHT + CHART_BOTTOM_PADDING
  const dealtColor = '#9be8dc'
  const takenColor = '#ffb06e'
  const barX = 300
  const barWidth = 318
  const maxValue = Math.max(
    1,
    ...players.map((player) => Math.max(
      safeNumber(player.stats?.damageDealtToChampions) || 0,
      safeNumber(player.stats?.damageTaken) || 0
    ))
  )

  fillRoundedRect(ctx, x, top, width, height, 24, 'rgba(255, 255, 255, 0.07)')
  strokeRoundedRect(ctx, x, top, width, height, 24, 'rgba(255, 255, 255, 0.11)')
  drawText(ctx, t('postGame.damageCompare'), x + 32, top + 36, {
    size: 22,
    weight: 800,
    color: '#9be8dc',
  })
  fillRoundedRect(ctx, x + width - 214, top + 20, 14, 14, 4, dealtColor)
  drawText(ctx, t('postGame.damageDealtShort'), x + width - 194, top + 33, {
    size: 16,
    weight: 700,
    color: 'rgba(214, 226, 238, 0.78)',
  })
  fillRoundedRect(ctx, x + width - 118, top + 20, 14, 14, 4, takenColor)
  drawText(ctx, t('postGame.damageTakenShort'), x + width - 98, top + 33, {
    size: 16,
    weight: 700,
    color: 'rgba(214, 226, 238, 0.78)',
  })

  players.forEach((player, index) => {
    const rowTop = top + CHART_HEADER_HEIGHT + index * CHART_ROW_HEIGHT
    const centerY = rowTop + CHART_ROW_HEIGHT / 2
    const nameColor = player.isSelf ? '#9be8dc' : '#f6fbff'
    const displayName = buildChampionDisplayName(player.champion)
    const summonerName = player.isSelf
      ? t('postGame.you')
      : String(player.summonerName || '').split('#')[0]

    if (index > 0) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)'
      ctx.beginPath()
      ctx.moveTo(x + 24, rowTop)
      ctx.lineTo(x + width - 24, rowTop)
      ctx.stroke()
    }

    // 左栏三行：英雄名 / 玩家名 / 称号徽标，宽度固定到柱子起点之前，互不重叠。
    const labelX = x + 82
    const labelMaxWidth = barX - labelX - 14
    drawCircularImage(ctx, images[index], x + 48, centerY, 22, displayName)
    drawText(ctx, displayName, labelX, centerY - 18, {
      size: 20,
      weight: 800,
      color: nameColor,
      maxWidth: labelMaxWidth,
    })
    drawText(ctx, summonerName, labelX, centerY + 2, {
      size: 15,
      weight: 600,
      color: 'rgba(214, 226, 238, 0.6)',
      maxWidth: labelMaxWidth,
    })
    if (player.rating) {
      drawHorseBadge(ctx, player.rating, labelX, centerY + 22, labelMaxWidth)
    }

    const dealt = safeNumber(player.stats?.damageDealtToChampions)
    const taken = safeNumber(player.stats?.damageTaken)
    drawDamageBar(ctx, barX, centerY - 20, barWidth, 16, (dealt || 0) / maxValue, dealtColor, formatLargeNumber(dealt))
    drawDamageBar(ctx, barX, centerY + 4, barWidth, 16, (taken || 0) / maxValue, takenColor, formatLargeNumber(taken))
  })
}

const HORSE_HONOR_PART_KEYS = {
  leader: 'postGame.horsePartLeader',
  top: 'postGame.horsePartTop',
  tank: 'postGame.horsePartTank',
  kills: 'postGame.horsePartKills',
  assists: 'postGame.horsePartAssists',
  heal: 'postGame.horsePartHeal',
  control: 'postGame.horsePartControl',
  deaths: 'postGame.horsePartDeaths',
}

const HORSE_HONOR_REASON_KEYS = {
  leader: 'postGame.horseReasonLeader',
  top: 'postGame.horseReasonTop',
  tank: 'postGame.horseReasonTank',
  kills: 'postGame.horseReasonKills',
  assists: 'postGame.horseReasonAssists',
  heal: 'postGame.horseReasonHeal',
  control: 'postGame.horseReasonControl',
  deaths: 'postGame.horseReasonDeaths',
}

// 拼名的固定顺序："板"永远紧挨着最后的"马"。
const HORSE_HONOR_ORDER = ['leader', 'top', 'tank', 'kills', 'assists', 'heal', 'control', 'deaths']

function getHorseHonors(rating) {
  const honors = Array.isArray(rating?.honors) ? rating.honors.filter((honor) => HORSE_HONOR_PART_KEYS[honor]) : []
  return HORSE_HONOR_ORDER.filter((honor) => honors.includes(honor))
}

/**
 * 称号名：把拿到的殊荣按顺序拼起来再加"马"，如"上等死马"；没有殊荣是"普通马"。
 */
function getHorseTitleLabel(rating) {
  if (!rating) return ''
  const honors = getHorseHonors(rating)
  const parts = honors.length
    ? honors.map((honor) => t(HORSE_HONOR_PART_KEYS[honor]))
    : [t('postGame.horsePartNormal')]
  return t('postGame.horseName', { parts: parts.join(t('postGame.horsePartJoiner')) })
}

/**
 * 每个殊荣一行描述，如"领头马：MVP 本局综合评分最高 8.7"；普通马一行说明。
 */
function getHorseTitleReasonLines(rating) {
  const honors = getHorseHonors(rating)
  if (!honors.length) return [t('postGame.horseReasonNormal')]
  return honors.map((honor) => {
    const value = rating.honorValues?.[honor]
    const name = t('postGame.horseName', { parts: t(HORSE_HONOR_PART_KEYS[honor]) })
    let reason
    if (honor === 'leader') {
      const bonus = Number(rating.itemBonus || 0) > 0 ? t('postGame.horseLeaderBonus') : ''
      reason = t(HORSE_HONOR_REASON_KEYS[honor], { value: Number(value || 0).toFixed(1), bonus })
    } else {
      const formatted = honor === 'top' || honor === 'tank' || honor === 'heal'
        ? formatLargeNumber(value)
        : String(Math.round(Number(value) || 0))
      reason = t(HORSE_HONOR_REASON_KEYS[honor], { value: formatted })
    }
    return t('postGame.horseReasonLine', { name, reason })
  })
}

function getHorseTitlePanelHeight(rating) {
  if (!rating) return 0
  return TITLE_PANEL_BASE_HEIGHT + getHorseTitleReasonLines(rating).length * TITLE_PANEL_LINE_HEIGHT
}

/**
 * 鎏金字：金色渐变填充 + 暖色外发光 + 顶部高光描边，用于"本局上等马"。
 */
function drawGoldenText(ctx, text, x, y, options = {}) {
  const { size = 30, weight = 900, align = 'right', baseline = 'alphabetic', maxWidth = null } = options
  ctx.save()
  ctx.font = `${weight} ${size}px ${FONT_FAMILY}`
  ctx.textAlign = align
  ctx.textBaseline = baseline

  let output = String(text || '')
  if (maxWidth && ctx.measureText(output).width > maxWidth) {
    while (output.length > 1 && ctx.measureText(`${output}...`).width > maxWidth) {
      output = output.slice(0, -1)
    }
    output = `${output}...`
  }
  const textWidth = ctx.measureText(output).width
  const left = align === 'right' ? x - textWidth : align === 'center' ? x - textWidth / 2 : x

  ctx.shadowColor = 'rgba(255, 196, 80, 0.75)'
  ctx.shadowBlur = 22
  ctx.fillStyle = 'rgba(255, 196, 80, 0.35)'
  ctx.fillText(output, x, y)

  ctx.shadowBlur = 0
  ctx.shadowColor = 'transparent'
  const gradient = ctx.createLinearGradient(left, y - size, left + textWidth, y + size * 0.3)
  gradient.addColorStop(0, '#fff3c4')
  gradient.addColorStop(0.28, '#f7d774')
  gradient.addColorStop(0.5, '#fff9df')
  gradient.addColorStop(0.72, '#e0a53a')
  gradient.addColorStop(1, '#b8781c')
  ctx.fillStyle = gradient
  ctx.fillText(output, x, y)

  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)'
  ctx.strokeText(output, x, y)
  ctx.restore()
}

/**
 * "本局称号"模块：放在战绩栏上方，标题小字 + 鎏金大字称号，下方一行获奖原因。
 */
function drawHorseTitlePanel(ctx, rating, top) {
  const x = 52
  const width = 646
  const height = getHorseTitlePanelHeight(rating)
  const label = getHorseTitleLabel(rating)
  if (!label) return

  fillRoundedRect(ctx, x, top, width, height, 24, 'rgba(242, 201, 76, 0.07)')
  strokeRoundedRect(ctx, x, top, width, height, 24, 'rgba(242, 201, 76, 0.28)')
  drawText(ctx, t('postGame.horseSection'), x + 32, top + 40, {
    size: 22,
    weight: 800,
    color: '#e7bd68',
  })
  const labelSize = label.length > 6 ? 40 : 50
  drawGoldenText(ctx, label, x + 32, top + 98, { size: labelSize, align: 'left', maxWidth: width - 64 })
  getHorseTitleReasonLines(rating).forEach((line, index) => {
    drawText(ctx, line, x + 32, top + 134 + index * TITLE_PANEL_LINE_HEIGHT, {
      size: 17,
      weight: 700,
      color: 'rgba(246, 236, 210, 0.78)',
      maxWidth: width - 64,
    })
  })
}

function drawHorseBadge(ctx, rating, x, centerY, maxWidth = null) {
  const label = getHorseTitleLabel(rating)
  if (!label) return

  ctx.font = `800 13px ${FONT_FAMILY}`
  const width = Math.min(ctx.measureText(label).width + 16, maxWidth || Number.POSITIVE_INFINITY)
  fillRoundedRect(ctx, x, centerY - 11, width, 22, 11, 'rgba(242, 201, 76, 0.14)')
  strokeRoundedRect(ctx, x, centerY - 11, width, 22, 11, 'rgba(242, 201, 76, 0.5)')
  drawGoldenText(ctx, label, x + width / 2, centerY + 1, { size: 13, weight: 800, align: 'center', baseline: 'middle', maxWidth: width - 12 })
}

function drawStatCell(ctx, x, y, width, height, label, value, accent) {
  fillRoundedRect(ctx, x, y, width, height, 18, 'rgba(255, 255, 255, 0.055)')
  strokeRoundedRect(ctx, x, y, width, height, 18, 'rgba(255, 255, 255, 0.09)')
  drawText(ctx, label, x + 26, y + 34, {
    size: 22,
    weight: 600,
    color: 'rgba(214, 226, 238, 0.72)',
  })
  drawText(ctx, value, x + 26, y + 86, {
    size: 38,
    weight: 800,
    color: accent,
    maxWidth: width - 52,
  })
}

function getAugmentAccent(augment) {
  const rarity = String(augment?.rarity || '').toLowerCase()
  if (rarity.includes('prismatic')) return '#caa8ff'
  if (rarity.includes('gold')) return '#e7bd68'
  if (rarity.includes('silver')) return '#f6fbff'
  return '#7fd7ff'
}

function getAugmentRarityLabel(augment) {
  const rarity = String(augment?.rarity || '').toLowerCase()
  if (rarity.includes('prismatic')) return t('postGame.rarityPrismatic')
  if (rarity.includes('gold')) return t('postGame.rarityGold')
  if (rarity.includes('silver')) return t('postGame.raritySilver')
  if (rarity.includes('unknown')) return t('postGame.rarityUnknown')
  return t('postGame.augment')
}

function drawAugmentCard(ctx, augment, image, y) {
  const x = 58
  const width = 634
  const height = 112
  const accent = getAugmentAccent(augment)
  const rarityLabel = getAugmentRarityLabel(augment)

  fillRoundedRect(ctx, x, y, width, height, 20, 'rgba(255, 255, 255, 0.06)')
  strokeRoundedRect(ctx, x, y, width, height, 20, 'rgba(255, 255, 255, 0.1)')
  drawHexIcon(ctx, x + 62, y + 56, 38, 'rgba(13, 20, 28, 0.95)', accent)

  if (image) {
    ctx.save()
    ctx.beginPath()
    ctx.arc(x + 62, y + 56, 29, 0, Math.PI * 2)
    ctx.clip()
    ctx.drawImage(image, x + 33, y + 27, 58, 58)
    ctx.restore()
  } else {
    drawText(ctx, rarityLabel.slice(0, 2), x + 62, y + 65, {
      size: 24,
      weight: 800,
      color: accent,
      align: 'center',
      baseline: 'middle',
    })
  }

  drawText(ctx, augment?.name || t('postGame.unknownAugment'), x + 122, y + 50, {
    size: 30,
    weight: 800,
    color: '#f8fcff',
    maxWidth: width - 164,
  })
  drawText(ctx, t('postGame.augmentSuffix', { rarity: rarityLabel }), x + 122, y + 82, {
    size: 20,
    weight: 600,
    color: 'rgba(214, 226, 238, 0.66)',
  })
}

function drawCompactAugmentCard(ctx, augment, image, x, y) {
  const width = 306
  const height = 92
  const accent = getAugmentAccent(augment)
  const rarityLabel = getAugmentRarityLabel(augment)

  fillRoundedRect(ctx, x, y, width, height, 18, 'rgba(255, 255, 255, 0.06)')
  strokeRoundedRect(ctx, x, y, width, height, 18, 'rgba(255, 255, 255, 0.1)')
  drawHexIcon(ctx, x + 46, y + 46, 30, 'rgba(13, 20, 28, 0.95)', accent)

  if (image) {
    ctx.save()
    ctx.beginPath()
    ctx.arc(x + 46, y + 46, 23, 0, Math.PI * 2)
    ctx.clip()
    ctx.drawImage(image, x + 23, y + 23, 46, 46)
    ctx.restore()
  } else {
    drawText(ctx, rarityLabel.slice(0, 2), x + 46, y + 52, {
      size: 18,
      weight: 800,
      color: accent,
      align: 'center',
      baseline: 'middle',
    })
  }

  drawText(ctx, augment?.name || t('postGame.unknownAugment'), x + 88, y + 39, {
    size: 22,
    weight: 800,
    color: '#f8fcff',
    maxWidth: width - 112,
  })
  drawText(ctx, t('postGame.augmentSuffix', { rarity: rarityLabel }), x + 88, y + 67, {
    size: 16,
    weight: 700,
    color: 'rgba(214, 226, 238, 0.62)',
    maxWidth: width - 112,
  })
}

function getPosterAugments(poster) {
  const augments = Array.isArray(poster?.augments) ? poster.augments.slice(0, 6) : []
  while (augments.length < 3) {
    augments.push({ name: t('postGame.unknownAugment'), rarity: 'unknown', imageDataUrl: null })
  }
  return augments
}

async function drawPoster() {
  await nextTick()
  const canvas = canvasRef.value
  if (!canvas) return

  const token = ++drawToken
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const poster = props.poster || {}
  const stats = poster.stats || {}
  const [kills, deaths, assists] = getKdaParts()
  const posterAugments = getPosterAugments(poster)
  const comparePlayerList = chartPlayers.value
  const titleOffset = titleShift.value
  const shift = layoutShift.value
  const canvasHeight = POSTER_HEIGHT + shift
  const championImagePromise = loadImage(poster.champion?.imageDataUrl)
  const augmentImagePromises = posterAugments.map((augment) =>
    loadImage(augment.imageDataUrl)
  )
  const comparePlayerImagePromises = comparePlayerList.map((player) =>
    loadImage(player.champion?.imageDataUrl)
  )
  const [championImage, augmentImages, comparePlayerImages] = await Promise.all([
    championImagePromise,
    Promise.all(augmentImagePromises),
    Promise.all(comparePlayerImagePromises),
  ])

  if (token !== drawToken) return

  if (canvas.height !== canvasHeight) {
    canvas.height = canvasHeight
  }
  ctx.clearRect(0, 0, POSTER_WIDTH, canvasHeight)
  drawBackground(ctx, canvasHeight)

  drawText(ctx, t('postGame.title'), 58, 70, {
    size: 24,
    weight: 800,
    color: '#9be8dc',
  })
  drawText(ctx, formatDuration(poster.durationSeconds), 58, 104, {
    size: 18,
    weight: 600,
    color: 'rgba(214, 226, 238, 0.58)',
  })

  fillRoundedRect(ctx, 580, 46, 112, 46, 23, 'rgba(255, 255, 255, 0.08)')
  strokeRoundedRect(ctx, 580, 46, 112, 46, 23, resultColor.value)
  drawText(ctx, resultLabel.value, 636, 76, {
    size: 24,
    weight: 900,
    color: resultColor.value,
    align: 'center',
  })

  fillRoundedRect(ctx, 52, 132, 646, 132, 28, 'rgba(255, 255, 255, 0.065)')
  strokeRoundedRect(ctx, 52, 132, 646, 132, 28, 'rgba(255, 255, 255, 0.1)')
  drawCircularImage(ctx, championImage, 126, 198, 50, championName.value)
  drawText(ctx, championName.value, 200, 188, {
    size: 34,
    weight: 900,
    color: '#ffffff',
    maxWidth: 390,
  })
  drawText(ctx, poster.summonerName || poster.queueName || 'ARAM', 202, 225, {
    size: 22,
    weight: 600,
    color: 'rgba(214, 226, 238, 0.68)',
    maxWidth: 340,
  })
  drawText(ctx, poster.queueName || 'ARAM', 640, 208, {
    size: 22,
    weight: 800,
    color: '#e86440',
    align: 'right',
  })

  if (poster.rating) {
    drawHorseTitlePanel(ctx, poster.rating, 300)
  }

  const statsTop = 300 + titleOffset
  fillRoundedRect(ctx, 52, statsTop, 646, 156, 24, 'rgba(255, 255, 255, 0.07)')
  strokeRoundedRect(ctx, 52, statsTop, 646, 156, 24, 'rgba(255, 255, 255, 0.11)')
  drawText(ctx, t('postGame.stats'), 84, statsTop + 46, {
    size: 22,
    weight: 800,
    color: '#9be8dc',
  })
  drawText(ctx, `${kills} / ${deaths} / ${assists}`, 84, statsTop + 114, {
    size: 58,
    weight: 900,
    color: '#ffffff',
    maxWidth: 582,
  })
  const cellWidth = 306
  drawStatCell(ctx, 52, statsTop + 194, cellWidth, 118, t('postGame.damage'), formatLargeNumber(stats.damageDealtToChampions), '#9be8dc')
  drawStatCell(ctx, 392, statsTop + 194, cellWidth, 118, t('postGame.damageTaken'), formatLargeNumber(stats.damageTaken), '#ffb06e')
  drawStatCell(ctx, 52, statsTop + 336, cellWidth, 118, t('postGame.gold'), formatLargeNumber(stats.goldEarned), '#e7bd68')
  drawStatCell(ctx, 392, statsTop + 336, cellWidth, 118, 'KDA', formatKdaValue(stats.kda), '#caa8ff')

  if (comparePlayerList.length > 1) {
    drawDamageCompare(ctx, CHART_TOP + titleOffset, comparePlayerList, comparePlayerImages)
  }

  drawText(ctx, t('postGame.augments'), 58, 820 + shift, {
    size: 28,
    weight: 900,
    color: '#ffffff',
  })
  drawText(ctx, 'Hextech Augments', 58, 852 + shift, {
    size: 18,
    weight: 700,
    color: 'rgba(214, 226, 238, 0.5)',
  })

  if (posterAugments.length <= 3) {
    posterAugments.forEach((augment, index) => {
      drawAugmentCard(ctx, augment, augmentImages[index], 882 + shift + index * 126)
    })
  } else {
    posterAugments.forEach((augment, index) => {
      const column = index % 2
      const row = Math.floor(index / 2)
      drawCompactAugmentCard(ctx, augment, augmentImages[index], 58 + column * 328, 882 + shift + row * 100)
    })
  }

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)'
  ctx.beginPath()
  ctx.moveTo(58, 1260 + shift)
  ctx.lineTo(692, 1260 + shift)
  ctx.stroke()
  drawText(ctx, t('postGame.footer'), 375, 1300 + shift, {
    size: 22,
    weight: 800,
    color: 'rgba(246, 251, 255, 0.86)',
    align: 'center',
  })
}

function exportPosterDataUrl() {
  const canvas = canvasRef.value
  if (!canvas) {
    throw new Error(t('postGame.notGenerated'))
  }
  return canvas.toDataURL('image/png')
}

function buildSuggestedFilename() {
  const name = championName.value.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '')
  return `aramgg-${name || 'post-game'}-${Date.now()}.png`
}

function showToast(message, type = 'success') {
  if (toastTimer) {
    clearTimeout(toastTimer)
    toastTimer = null
  }

  toast.value = {
    visible: true,
    message,
    type,
  }

  toastTimer = setTimeout(() => {
    toast.value = {
      ...toast.value,
      visible: false,
    }
    toastTimer = null
  }, 2200)
}

async function runPosterAction(action, actionName) {
  actionPending.value = true
  try {
    await drawPoster()
    await action(exportPosterDataUrl())
  } catch (error) {
    if (actionName) {
      trackPostGameShareEvent(`post_game_share_${actionName}_failure`, {
        button: actionName,
        error_message: error?.message || String(error || 'unknown'),
      })
    }
    showToast(error?.message || t('postGame.operationFailed'), 'error')
  } finally {
    actionPending.value = false
  }
}

async function copyPoster() {
  trackPostGameShareEvent('post_game_share_copy_click', {
    button: 'copy',
  })
  await runPosterAction(async (dataUrl) => {
    const result = await electronAPI.postGameShare.copyImage(dataUrl)
    if (!result?.success) {
      throw new Error(result?.error || t('postGame.copyFailed'))
    }
    trackPostGameShareEvent('post_game_share_copy_success', {
      button: 'copy',
    })
    showToast(t('postGame.copied'))
  }, 'copy')
}

async function savePoster() {
  trackPostGameShareEvent('post_game_share_save_click', {
    button: 'save',
  })
  await runPosterAction(async (dataUrl) => {
    const result = await electronAPI.postGameShare.saveImage(dataUrl, buildSuggestedFilename())
    if (result?.cancelled) {
      trackPostGameShareEvent('post_game_share_save_cancel', {
        button: 'save',
      })
      return
    }
    if (!result?.success) {
      throw new Error(result?.error || t('postGame.saveFailed'))
    }
    trackPostGameShareEvent('post_game_share_save_success', {
      button: 'save',
    })
    showToast(t('postGame.saved'))
  }, 'save')
}

watch(
  () => [props.poster, locale.value],
  () => {
    syncSelectedPlayers()
    drawPoster()
  },
  { deep: true }
)

watch(selectedPlayerKeys, () => {
  drawPoster()
})

onMounted(() => {
  drawPoster()
  void loadPinnedPlayers().then(() => drawPoster())
})

onBeforeUnmount(() => {
  if (toastTimer) {
    clearTimeout(toastTimer)
    toastTimer = null
  }
})
</script>

<style scoped>
.post-share-overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
  background: rgba(0, 0, 0, 0.62);
  backdrop-filter: blur(10px);
}

/* 独立小窗模式：铺满窗口，不要遮罩和外边距。 */
.post-share-overlay-window {
  padding: 0;
  background: transparent;
  backdrop-filter: none;
  align-items: stretch;
}

.post-share-overlay-window .post-share-modal {
  width: 100%;
  max-height: 100dvh;
  border-radius: 10px;
}

.post-share-modal {
  width: min(100%, 640px);
  max-height: calc(100dvh - 36px);
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;
  border-radius: 8px;
  padding: 12px;
  background:
    linear-gradient(180deg, rgba(21, 31, 40, 0.98), rgba(8, 14, 20, 0.98)),
    #0b1016;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
}

.post-share-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 2px 2px 0;
}

.post-share-kicker {
  margin: 0 0 4px;
  color: #9be8dc;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0;
}

.post-share-header h2 {
  margin: 0;
  color: #f7fbff;
  font-size: 17px;
  line-height: 1.15;
  text-wrap: balance;
}

.post-share-icon-button {
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  color: #d7e4f1;
  background: rgba(255, 255, 255, 0.07);
  cursor: pointer;
  transition-property: scale, background-color;
  transition-duration: 150ms;
  transition-timing-function: ease-out;
}

.post-share-icon-button:hover {
  background: rgba(255, 255, 255, 0.11);
}

.post-share-icon-button:active {
  scale: 0.96;
}

.post-share-icon {
  width: 18px;
  height: 18px;
}

.post-share-preview {
  min-height: 0;
  flex: 1 1 auto;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  overflow: auto;
  padding: 0;
  background: transparent;
  box-shadow: none;
}

/* 海报按窗口可用空间等比缩放：宽不超过弹窗，高不超过视口减去标题、对比列表和按钮的空间。 */
.post-share-canvas {
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: calc(100dvh - 260px);
  border-radius: 8px;
  outline: 1px solid rgba(255, 255, 255, 0.1);
  outline-offset: -1px;
  box-shadow: 0 18px 36px rgba(0, 0, 0, 0.38);
}

.post-share-compare {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
  outline: 1px solid rgba(255, 255, 255, 0.08);
  outline-offset: -1px;
}

.post-share-compare-header {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.post-share-compare-title {
  color: #9be8dc;
  font-size: 12px;
  font-weight: 800;
}

.post-share-compare-hint {
  color: rgba(214, 226, 238, 0.55);
  font-size: 11px;
  line-height: 1.3;
}

.post-share-compare-list {
  max-height: min(148px, 22dvh);
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.post-share-compare-group {
  margin: 4px 0 0;
  color: rgba(214, 226, 238, 0.5);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.04em;
}

.post-share-compare-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) minmax(0, 1.2fr) auto;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  padding: 0 4px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

.post-share-compare-row:hover {
  background: rgba(255, 255, 255, 0.05);
}

.post-share-compare-row.pinned {
  background: rgba(155, 232, 220, 0.08);
}

.post-share-compare-checkbox {
  width: 14px;
  height: 14px;
  accent-color: #9be8dc;
  cursor: pointer;
}

.post-share-compare-champion {
  color: #f7fbff;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.post-share-compare-summoner {
  color: rgba(214, 226, 238, 0.62);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.post-share-pin {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 4px;
  color: rgba(214, 226, 238, 0.45);
  background: transparent;
  cursor: pointer;
}

.post-share-pin:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #f7fbff;
}

.post-share-pin.active {
  color: #e7bd68;
}

.post-share-pin-icon {
  width: 13px;
  height: 13px;
}

.post-share-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.post-share-action {
  min-height: 42px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 0;
  border-radius: 6px;
  color: #071015;
  background: #9be8dc;
  font-size: 13px;
  font-weight: 800;
  cursor: pointer;
  transition-property: scale, background-color, opacity;
  transition-duration: 150ms;
  transition-timing-function: ease-out;
}

.post-share-action.accent {
  background: #e7bd68;
}

.post-share-action:hover:not(:disabled) {
  background: #b8fff4;
}

.post-share-action.accent:hover:not(:disabled) {
  background: #ffd98a;
}

.post-share-action:active:not(:disabled) {
  scale: 0.96;
}

.post-share-action:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.post-share-action-icon {
  width: 16px;
  height: 16px;
}

.post-share-toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  z-index: 60;
  transform: translate(-50%, 0);
  min-height: 42px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 14px;
  border-radius: 21px;
  color: #071015;
  background: #9be8dc;
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.16),
    0 16px 34px rgba(0, 0, 0, 0.38);
  font-size: 13px;
  font-weight: 900;
  text-wrap: pretty;
}

.post-share-toast.error {
  color: #22090a;
  background: #ffb4ab;
}

.post-share-toast-icon {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
}

.post-share-toast-enter-active,
.post-share-toast-leave-active {
  transition-property: opacity, transform, filter;
  transition-duration: 180ms;
  transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
}

.post-share-toast-enter-from,
.post-share-toast-leave-to {
  opacity: 0;
  filter: blur(4px);
  transform: translate(-50%, 12px);
}

.post-share-toast-enter-to,
.post-share-toast-leave-from {
  opacity: 1;
  filter: blur(0);
  transform: translate(-50%, 0);
}

</style>
