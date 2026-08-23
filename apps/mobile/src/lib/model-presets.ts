import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  modelPresetKey,
  parseModelPresets,
  serializeModelPresets,
  type ModelPreset,
  type ModelPresetMap,
} from './session-runtime';

const STORAGE_KEY = 'brio:model-presets:v1';

export async function loadModelPresets(): Promise<ModelPresetMap> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return parseModelPresets(JSON.parse(raw));
  } catch {
    return {};
  }
}

export async function getModelPreset(
  provider: string,
  model: string,
): Promise<ModelPreset | undefined> {
  const presets = await loadModelPresets();
  return presets[modelPresetKey(provider, model)];
}

export async function setModelPreset(
  provider: string,
  model: string,
  patch: ModelPreset,
): Promise<ModelPresetMap> {
  const key = modelPresetKey(provider, model);
  const current = await loadModelPresets();
  // Merge the patch into this model's preset only; every other model entry is
  // preserved untouched.
  const merged = Object.entries({ ...current[key], ...patch }).filter(
    ([, value]) => value !== undefined,
  );
  const next: ModelPresetMap = { ...current };
  if (merged.length === 0) delete next[key];
  else next[key] = Object.fromEntries(merged);
  await AsyncStorage.setItem(STORAGE_KEY, serializeModelPresets(next));
  return next;
}
