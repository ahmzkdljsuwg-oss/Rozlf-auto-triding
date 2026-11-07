'use strict';

const SPEED_PRESETS = {
  slow: {
    id: 'slow', icon: '🐢',
    label_en: 'Slow', label_ar: 'بطيء',
    scan_interval_seconds: 90,
    min_confidence: 0.72,
    require_h4: true,
  },
  medium: {
    id: 'medium', icon: '⚖️',
    label_en: 'Medium', label_ar: 'متوسط',
    scan_interval_seconds: 30,
    min_confidence: 0.62,
    require_h4: false,
  },
  fast: {
    id: 'fast', icon: '⚡',
    label_en: 'Fast', label_ar: 'سريع',
    scan_interval_seconds: 10,
    min_confidence: 0.57,
    require_h4: false,
  },
};

const DEFAULT_SPEED = 'medium';

function getSpeedPreset(mode) {
  return SPEED_PRESETS[mode] || SPEED_PRESETS[DEFAULT_SPEED];
}

function isSpeedMode(mode) {
  return Object.prototype.hasOwnProperty.call(SPEED_PRESETS, mode);
}

module.exports = { SPEED_PRESETS, DEFAULT_SPEED, getSpeedPreset, isSpeedMode };
