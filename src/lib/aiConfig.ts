import { supabase } from '@/lib/supabase';

export const AI_MODELS = [
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
  { id: 'gemini-3-flash', label: 'Gemini 3 Flash' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
] as const;

export type AiModelId = (typeof AI_MODELS)[number]['id'];

const AI_MODEL_KEY = 'ai_model';
const DEFAULT_MODEL: AiModelId = 'gemini-3.5-flash-lite';

export async function loadAiModel(): Promise<AiModelId> {
  const { data } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', AI_MODEL_KEY)
    .maybeSingle();
  const val = data?.value;
  if (val && AI_MODELS.some((m) => m.id === val)) return val as AiModelId;
  return DEFAULT_MODEL;
}

export async function saveAiModel(modelId: AiModelId): Promise<void> {
  const { error } = await supabase
    .from('app_config')
    .upsert({ key: AI_MODEL_KEY, value: modelId }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
}
