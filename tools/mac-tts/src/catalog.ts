import { z } from "zod";
import { readFileSync } from "node:fs";
const revisions = JSON.parse(
  readFileSync(new URL("../../models.lock.json", import.meta.url), "utf8"),
) as Record<string, string>;
export const idSchema = z.string().uuid();
const text = z.string().min(1).max(12000);
const short = z.string().min(1).max(2000);
const probability = z.number().min(0).max(1);
const tokens = z.number().int().min(16).max(4096);
const sampling = {
  temperature: z.number().min(0.01).max(2),
  top_k: z.number().int().min(0).max(1000),
  top_p: probability,
  repetition_penalty: z.number().min(1).max(3),
};
const streaming = {
  stream: z.boolean(),
  streaming_interval: z.number().min(0.2).max(10),
};
const qlangs = [
  "auto",
  "Chinese",
  "English",
  "Japanese",
  "Korean",
  "German",
  "French",
  "Russian",
  "Portuguese",
  "Spanish",
  "Italian",
] as const;
const speakers = [
  "Vivian",
  "Serena",
  "Uncle_Fu",
  "Dylan",
  "Eric",
  "Ryan",
  "Aiden",
  "Ono_Anna",
  "Sohee",
] as const;
const clangs = [
  "ar",
  "da",
  "de",
  "el",
  "en",
  "es",
  "fi",
  "fr",
  "he",
  "hi",
  "it",
  "ja",
  "ko",
  "ms",
  "nl",
  "no",
  "pl",
  "pt",
  "ru",
  "sv",
  "sw",
  "tr",
  "zh",
] as const;
const base = {
  text,
  seed: z.number().int().min(0).max(2147483647),
  voice_id: idSchema,
};
const ref = { reference_id: idSchema };
// Deliberately omit **kwargs and parameters upstream ignores. Unknown keys fail.
const qcommon = {
  ...base,
  ...sampling,
  ...streaming,
  language: z.enum(qlangs),
  max_tokens: tokens,
};
const schema = (shape: Record<string, z.ZodType>, required: string[] = []) =>
  z.strictObject(
    Object.fromEntries(
      Object.entries(shape).map(([k, v]) => [
        k,
        required.includes(k) ? v : v.optional(),
      ]),
    ),
  );
export type Model = {
  id: string;
  repo: string;
  runtime: "mlx" | "qwen" | "fish" | "firered" | "text";
  mode: string;
  schema: z.ZodType;
  streaming: string;
  notes: string[];
};
export const models: Model[] = [{
  id: "qwen-text", repo: "Qwen/Qwen3-14B-MLX-4bit", runtime: "text", mode: "text",
  schema: schema({ text: z.string().min(1).max(180000), system: z.string().min(1).max(20000), max_tokens: z.number().int().min(256).max(16000), temperature: z.number().min(0).max(1), seed: z.number().int().min(0).max(2147483647) }, ["text", "system"]),
  streaming: "Final structured text in job.result.text", notes: ["Local chapter analysis; shares the single GPU worker with speech.", "Text is validated against exact source units before casting or speech."]
}];
for (const [mode, suffix] of [
  ["custom", "CustomVoice"],
  ["design", "VoiceDesign"],
  ["base", "Base"],
] as const) {
  const specific =
    mode === "custom"
      ? { speaker: z.enum(speakers), instruct: short }
      : mode === "design"
        ? { instruct: short }
        : { ...ref, ref_text: short, x_vector_only_mode: z.boolean() };
  models.push({
    id: `qwen-${mode}`,
    repo: `mlx-community/Qwen3-TTS-12Hz-1.7B-${suffix}-bf16`,
    runtime: "mlx",
    mode,
    schema: schema(
      {
        ...qcommon,
        ...specific,
        ...(mode !== "design"
          ? { text: z.union([text, z.array(text).min(1).max(4)]) }
          : {}),
        ...(mode === "custom"
          ? {
              speaker: z.union([
                z.enum(speakers),
                z.array(z.enum(speakers)).min(1).max(4),
              ]),
              instruct: z.union([short, z.array(short).min(1).max(4)]),
            }
          : {}),
      },
      ["text"],
    ),
    streaming: "incremental audio chunks",
    notes:
      mode === "base"
        ? [
            "Without a transcript, x_vector_only_mode must be true. MLX ICL enforces repetition_penalty >= 1.5. Reusable voice IDs persist reference audio and transcript; encoding is cached within a loaded worker.",
          ]
        : [
            "Subtalker controls require the explicit qwen-" +
              mode +
              "-native model.",
          ],
  });
  const { stream, streaming_interval, ...nativeCommon } = qcommon;
  models.push({
    id: `qwen-${mode}-native`,
    repo: `Qwen/Qwen3-TTS-12Hz-1.7B-${suffix}`,
    runtime: "qwen",
    mode,
    schema: schema(
      {
        ...nativeCommon,
        ...specific,
        text: z.union([text, z.array(text).min(1).max(4)]),
        language: z.union([
          z.enum(qlangs),
          z.array(z.enum(qlangs)).min(1).max(4),
        ]),
        ...(mode === "custom"
          ? {
              speaker: z.union([
                z.enum(speakers),
                z.array(z.enum(speakers)).min(1).max(4),
              ]),
              instruct: z.union([short, z.array(short).min(1).max(4)]),
            }
          : mode === "design"
            ? { instruct: z.union([short, z.array(short).min(1).max(4)]) }
            : {}),
        do_sample: z.boolean(),
        subtalker_dosample: z.boolean(),
        subtalker_top_k: sampling.top_k,
        subtalker_top_p: probability,
        subtalker_temperature: sampling.temperature,
        non_streaming_mode: z.boolean(),
      },
      ["text"],
    ),
    streaming: "none: official Python API returns a completed waveform",
    notes: [
      "PyTorch MPS, eager attention. Separate environment for upstream transformers 4.57.3. Base voice IDs cache serialized tensor prompts on disk. non_streaming_mode controls text conditioning, not HTTP streaming.",
    ],
  });
}
models.push({
  id: "chatterbox",
  repo: "mlx-community/Chatterbox-TTS-fp16",
  runtime: "mlx",
  mode: "chatterbox",
  schema: schema(
    {
      ...base,
      ...ref,
      temperature: sampling.temperature,
      top_p: probability,
      min_p: probability,
      repetition_penalty: sampling.repetition_penalty,
      exaggeration: z.number().min(0).max(2),
      cfg_weight: z.number().min(0).max(2),
      max_tokens: tokens,
    },
    ["text"],
  ),
  streaming: "none",
  notes: [
    "Original expressive English model. This checkpoint requires reference_id or saved voice_id because default conditioning is absent. No speed control or native streaming.",
  ],
});
models.push({
  id: "chatterbox-multilingual",
  repo: "mlx-community/chatterbox-multilingual-v3",
  runtime: "mlx",
  mode: "chatterbox",
  schema: schema(
    {
      ...base,
      ...ref,
      language: z.enum(clangs),
      temperature: sampling.temperature,
      top_p: probability,
      min_p: probability,
      repetition_penalty: sampling.repetition_penalty,
      exaggeration: z.number().min(0).max(2),
      cfg_weight: z.number().min(0).max(2),
      max_tokens: tokens,
    },
    ["text"],
  ),
  streaming: "none",
  notes: ["23 languages; expressive controls and reference voice cloning."],
});
models.push({
  id: "chatterbox-turbo",
  repo: "mlx-community/chatterbox-turbo-fp16",
  runtime: "mlx",
  mode: "turbo",
  schema: schema(
    {
      ...base,
      ...ref,
      ...sampling,
      ...streaming,
      norm_loudness: z.boolean(),
      max_tokens: tokens,
      split: z.enum(["sentence", "newline", "none"]),
    },
    ["text"],
  ),
  streaming: "incremental audio chunks",
  notes: [
    "Reference audio must exceed 5 seconds. English; inline tags: [laugh], [chuckle], [cough], [sigh], [gasp], [groan], [sniff], [shush], [clear throat]. CFG, exaggeration and min_p are ignored upstream and rejected here.",
  ],
});
export const kokoroVoices = [
  "af_alloy",
  "af_aoede",
  "af_bella",
  "af_heart",
  "af_jessica",
  "af_kore",
  "af_nicole",
  "af_nova",
  "af_river",
  "af_sarah",
  "af_sky",
  "am_adam",
  "am_echo",
  "am_eric",
  "am_fenrir",
  "am_liam",
  "am_michael",
  "am_onyx",
  "am_puck",
  "am_santa",
  "bf_alice",
  "bf_emma",
  "bf_isabella",
  "bf_lily",
  "bm_daniel",
  "bm_fable",
  "bm_george",
  "bm_lewis",
  "ef_dora",
  "em_alex",
  "em_santa",
  "ff_siwis",
  "hf_alpha",
  "hf_beta",
  "hm_omega",
  "hm_psi",
  "if_sara",
  "im_nicola",
  "jf_alpha",
  "jf_gongitsune",
  "jf_nezumi",
  "jf_tebukuro",
  "jm_kumo",
  "pf_dora",
  "pm_alex",
  "pm_santa",
  "zf_xiaobei",
  "zf_xiaoni",
  "zf_xiaoxiao",
  "zf_xiaoyi",
  "zm_yunjian",
  "zm_yunxi",
  "zm_yunxia",
  "zm_yunyang",
] as const;
models.push({
  id: "kokoro",
  repo: "mlx-community/Kokoro-82M-bf16",
  runtime: "mlx",
  mode: "kokoro",
  schema: schema(
    {
      ...base,
      voice: z.enum(kokoroVoices),
      blend: z
        .array(
          z.strictObject({
            voice: z.enum(kokoroVoices),
            weight: z.number().positive().max(100),
          }),
        )
        .min(1)
        .max(8),
      language: z.enum(["a", "b", "e", "f", "h", "i", "j", "p", "z"]),
      speed: z.number().min(0.5).max(2),
      split: z.enum(["newline", "sentence", "none"]),
      phonemes: z.boolean(),
    },
    ["text"],
  ),
  streaming: "text segment chunks (not autoregressive streaming)",
  notes: [
    "Weighted voice blends; phonemes=true accepts phoneme input. Fixed safe chunk patterns. Japanese/Chinese use installed Misaki extras; other languages use espeak-ng.",
  ],
});
models.push({
  id: "fish-s2-pro",
  repo: "appautomaton/fishaudio-s2-pro-8bit-mlx",
  runtime: "fish",
  mode: "fish",
  schema: schema(
    {
      ...base,
      max_tokens: z.number().int().min(16).max(8192),
      temperature: z.number().min(0).max(2),
      top_p: z.number().positive().max(1),
      top_k: z.number().int().min(0).max(1024),
      ras_window: z.number().int().min(0).max(100),
      ras_temperature: z.number().min(0).max(2),
      ras_top_p: z.number().positive().max(1),
      references: z
        .array(
          z.strictObject({
            speaker: z.number().int().min(0).max(4),
            reference_id: idSchema,
            transcript: short,
          }),
        )
        .min(1)
        .max(5),
    },
    ["text"],
  ),
  streaming:
    "none: completed waveform; one native generation retains dialogue context",
  notes: [
    "Local S2 Pro open weights, 8-bit. Native <|speaker:i|> tags and free-form [direction] tags. Reference transcripts are tagged and reference codec frames concatenated in matching order, as in original Fish Speech. No S2.1 or hosted service.",
    "No native batch or streaming interface in this port. Speed, CFG and repetition_penalty are rejected; repetition-aware sampling is controlled by ras_window, ras_temperature and ras_top_p.",
  ],
});
const dialogueRefs = (start: number, transcriptRequired: boolean) =>
  z
    .array(
      z.strictObject({
        speaker: z
          .number()
          .int()
          .min(start)
          .max(start + 4),
        reference_id: idSchema,
        transcript: transcriptRequired ? short : short.optional(),
      }),
    )
    .min(1)
    .max(5);
models.push({
  id: "moss-ttsd",
  repo: "appautomaton/openmoss-ttsd-mlx",
  runtime: "fish",
  mode: "moss",
  schema: schema(
    {
      ...base,
      text: z.union([text, z.array(text).min(1).max(2)]),
      references: dialogueRefs(1, false),
      conditioning: z.enum([
        "generation",
        "voice_clone",
        "continuation",
        "voice_clone_and_continuation",
      ]),
      max_new_tokens: tokens,
      use_kv_cache: z.boolean(),
      do_sample: z.boolean(),
      audio_temperature: z.number().min(0).max(2),
      audio_top_p: z.number().positive().max(1),
      audio_top_k: sampling.top_k,
      audio_repetition_penalty: sampling.repetition_penalty,
      text_temperature: z.number().min(0).max(2),
      text_top_p: z.number().positive().max(1),
      text_top_k: sampling.top_k,
      text_normalize: z.boolean(),
      sample_rate_normalize: z.boolean(),
    },
    ["text"],
  ),
  streaming: "none",
  notes: [
    "Native [S1] through [S5] dialogue with separate references, clone and continuation modes. Native batch up to 2 uses uncached generation; cap 512 rows. No arbitrary style, speed, streaming or CFG controls.",
  ],
});
models.push({
  id: "higgs-v2",
  repo: "mlx-community/higgs-audio-v2-3B-mlx-q8",
  runtime: "mlx",
  mode: "higgs",
  schema: schema(
    {
      ...base,
      references: dialogueRefs(0, true),
      scene_prompt: short,
      max_new_frames: z.number().int().min(16).max(2500),
      temperature: z.number().min(0).max(2),
      top_p: z.number().positive().max(1),
      top_k: z.union([z.literal(0), z.number().int().min(2).max(1000)]),
      ras_win_len: z.number().int().min(0).max(100),
      ras_max_repeat: z.number().int().min(1).max(20),
      sampling_warmup_frames: z.number().int().min(0).max(100),
      fade_in_ms: z.number().min(0).max(100),
      fade_out_ms: z.number().min(0).max(100),
      stream: z.boolean(),
      emit_every_frames: z.number().int().min(8).max(100),
      overlap_ms: z.number().min(1).max(100),
    },
    ["text"],
  ),
  streaming: "native overlap-add audio chunks",
  notes: [
    "Experimental joint [SPEAKER0] through [SPEAKER4] conditioning: two-speaker short test passed, but a three-speaker full scene stalled. Use single-reference per-turn generation for reliable coverage. Tagged reference user/audio assistant pairs follow original Higgs prompt assembly; all target turns share one generation. scene_prompt guides delivery. No native batch, speed or CFG.",
  ],
});
models.push({
  id: "vibevoice-7b",
  repo: "appautomaton/vibevoice-mlx",
  runtime: "fish",
  mode: "vibe",
  schema: schema(
    {
      ...base,
      references: z
        .array(
          z.strictObject({
            speaker: z.number().int().min(0).max(3),
            reference_id: idSchema,
          }),
        )
        .min(1)
        .max(4),
      max_new_tokens: z.number().int().min(16).max(2048),
      cfg_scale: z.number().min(0).max(5),
      diffusion_steps: z.number().int().min(1).max(50),
      diffusion_steps_fast: z.number().int().min(1).max(50),
      diffusion_warmup_frames: z.number().int().min(0).max(100),
      do_sample: z.boolean(),
      temperature: z.number().positive().max(2),
      top_p: z.number().positive().max(1),
    },
    ["text"],
  ),
  streaming:
    "none: selected native API returns accumulated chunks after completion",
  notes: [
    "Native dialogue uses zero-based Speaker 0: labels. Reference IDs must be contiguous starting at 0. 7B int8 with semantic feedback always enabled. One generation retains all speaker turns. No native batch, speed, free-form instruct or transcript conditioning.",
  ],
});
models.push({
  id: "fireredtts2",
  repo: "FireRedTeam/FireRedTTS2",
  runtime: "firered",
  mode: "firered",
  schema: schema(
    {
      ...base,
      references: z
        .array(
          z.strictObject({
            speaker: z.number().int().min(1).max(4),
            reference_id: idSchema,
            transcript: short,
          }),
        )
        .min(1)
        .max(4),
      temperature: z.number().positive().max(2),
      topk: z.number().int().min(1).max(100),
      max_audio_length_ms: z.number().int().min(1000).max(30000),
      stream: z.boolean(),
    },
    ["text"],
  ),
  streaming:
    "Native codec chunks when stream=true; otherwise completed turn chunks",
  notes: [
    "Official dialogue checkpoint, float32 MPS. [S1] through [S4] tags. Each turn conditions on all references and earlier generated audio, then outputs are concatenated; not one uninterrupted decode. Reference transcripts required. No batch, speed, CFG or free-form instruct. Context overflow fails rather than truncating or dropping prior turns.",
  ],
});
export function modelById(id: string): Model {
  const m = models.find((x) => x.id === id);
  if (!m)
    throw new Error("Unknown model; GET /v1/models lists allowed model IDs");
  return m;
}
export function capabilities() {
  return models.map(({ schema, ...m }) => ({
    ...m,
    revision: revisions[m.repo],
    batch:
      m.mode === "moss"
        ? "native up to 2, uncached; max 512 rows"
        : m.runtime === "qwen"
          ? "native, up to 4 utterances"
          : m.id === "qwen-custom"
            ? "native, up to 4 utterances; shared language"
            : m.id === "qwen-base"
              ? "native ICL, up to 4 utterances; shared reference and transcript"
              : "not supported; submit individual jobs",
    schema: z.toJSONSchema(schema),
    requirements:
      m.id === "chatterbox"
        ? [
            "reference_id (or saved voice_id); checkpoint has no default conditioning",
          ]
        : m.mode === "base"
          ? [
              "reference_id (or saved voice_id)",
              "ref_text unless x_vector_only_mode=true",
            ]
          : m.mode === "custom"
            ? ["speaker (or saved voice_id)"]
            : m.mode === "design"
              ? ["instruct (or saved voice_id)"]
              : [],
  }));
}
export type Input = Record<string, unknown> & { text: string | string[] };
export function validate(model: Model, raw: unknown): Input {
  return model.schema.parse(raw) as Input;
}
