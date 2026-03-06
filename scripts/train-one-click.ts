import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
// 🧠 已迁移到 BrainNN v5.0
import { BrainNNAdapter, getBrainNNAdapter } from '../memory-universe/src/core/BrainNNAdapter';
import { CandidateGenerator } from '../memory-universe/src/core/CandidateGenerator';
import { BehaviorType } from '../memory-universe/src/types';

type ManualRating = string;
type SampleLabel = 'positive' | 'negative';

interface TrainingSample {
  id?: string;
  timestamp?: number;
  sessionId?: string;
  turnId?: string;
  features: {
    stateVector: number[];
    perceptionVector: number[];
    messageEmbedding: number[];
    memoryContextEmbedding: number[];
  };
  label: {
    selectedCandidate: string;
    candidateScores?: Record<string, number>;
    wasRejected?: boolean;
    riskHint?: number;
    userFeedback?: 'positive' | 'negative' | 'neutral';
  };
  metadata?: {
    timestamp?: number;
    turnId?: string;
    quality?: number;
    weight?: number;
    isNegative?: boolean;
    isNegativeExample?: boolean;
    usedInTraining?: boolean;
    trainedAt?: number;
    trainedModelVersion?: string;
    manualRating?: ManualRating;
    notes?: string;
    inputText?: string;
    outputText?: string;
    userId?: string;
  };
}

type DatasetObject = {
  samples: TrainingSample[];
  rejectedSamples?: unknown[];
  metadata?: Record<string, unknown>;
};

const POSITIVE_RATING = '\uD83D\uDC4D'; // 👍
const NEGATIVE_RATING = '\uD83D\uDC4E'; // 👎

const CONFIG = {
  SAMPLES_PATH: path.join(__dirname, '..', 'data', 'training', 'samples.json'),
  WEIGHTS_DIR: path.join(__dirname, '..', 'data', 'models'),
  // 🧠 更新权重路径为 BrainNN v5.0
  WEIGHTS_PATH: path.join(__dirname, '..', 'data', 'models', 'brain-nn-weights-v5.json'),
  BACKUP_PATH: path.join(__dirname, '..', 'data', 'models', 'brain-nn-weights-v5.backup.json'),
  REPORT_PATH: path.join(__dirname, '..', 'data', 'models', 'training-report.json'),
  INPUT_DIM: 99,
  OUTPUT_DIM: 200,
  PROJECTED_EMBED_DIM: 32,
  EPOCHS: Math.max(1, parseInt(process.env.TRAINING_EPOCHS || '3', 10)),
  BATCH_SIZE: Math.max(1, parseInt(process.env.TRAINING_BATCH_SIZE || '64', 10)),
  LEARNING_RATE: parseFloat(process.env.TRAINING_LEARNING_RATE || '0.0001'),
  MIN_SAMPLES: Math.max(1, parseInt(process.env.MIN_SAMPLES_FOR_TRAINING || '100', 10)),
  MIN_POSITIVE: Math.max(1, parseInt(process.env.TRAINING_MIN_POSITIVE_SAMPLES || '10', 10)),
  MIN_NEGATIVE: Math.max(0, parseInt(process.env.TRAINING_MIN_NEGATIVE_SAMPLES || '0', 10)),  // 允许无负样本
  MAX_SAMPLES: Math.max(1, parseInt(process.env.MAX_SAMPLES_PER_SESSION || '1000', 10)),
  VALIDATION_SPLIT: Math.min(0.5, Math.max(0.05, parseFloat(process.env.TRAINING_VALIDATION_SPLIT || '0.2'))),
  POSITIVE_MIN_QUALITY: Math.min(1, Math.max(0, parseFloat(process.env.TRAINING_POSITIVE_MIN_QUALITY || '0.6'))),
  MIN_AVG_QUALITY: Math.min(1, Math.max(0, parseFloat(process.env.TRAINING_MIN_AVG_QUALITY || '0.5'))),
  FAIL_ON_LOW_QUALITY: (process.env.TRAINING_FAIL_ON_LOW_QUALITY || 'true').toLowerCase() !== 'false',
  POS_TO_NEG_RATIO: Math.max(1, parseInt(process.env.TRAINING_POSITIVE_TO_NEGATIVE_RATIO || '3', 10)),
  INCLUDE_TRAINED: (process.env.TRAINING_INCLUDE_TRAINED || 'false').toLowerCase() === 'true'
};

const ALLOWED_BEHAVIORS: BehaviorType[] = [
  'reply_friendly',
  'reply_supportive',
  'reply_playful',
  'tease_light',
  'tease_heavy',
  'dodge',
  'silent',
  'topic_shift',
  'boundary_warning',
  'clarify_question',
  'proactive_recall_context',
  'proactive_recall_user',
  'narrate_self_recent',
  'meme_trigger',
  'analytical_answer_short',
  'emotional_resonate',
  'apology_soft',
  'refuse_safely'
];

function stableId(sample: TrainingSample): string {
  if (sample.id && typeof sample.id === 'string' && sample.id.length > 0) return sample.id;
  const basis = JSON.stringify({
    timestamp: sample.timestamp ?? sample.metadata?.timestamp ?? null,
    turnId: sample.turnId ?? sample.metadata?.turnId ?? null,
    sessionId: sample.sessionId ?? null,
    selectedCandidate: sample.label?.selectedCandidate ?? null,
    inputText: sample.metadata?.inputText ?? null,
    outputText: sample.metadata?.outputText ?? null
  });
  const digest = crypto.createHash('sha1').update(basis).digest('hex');
  return `sample_${digest}`;
}

function ensureIds(samples: TrainingSample[]): TrainingSample[] {
  return samples.map((s) => ({ ...s, id: stableId(s) }));
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

function readDataset(): { dataset: DatasetObject; originalFormat: 'array' | 'object' } {
  if (!fs.existsSync(CONFIG.SAMPLES_PATH)) {
    throw new Error(`Training samples not found: ${CONFIG.SAMPLES_PATH}`);
  }

  const text = fs.readFileSync(CONFIG.SAMPLES_PATH, 'utf-8').replace(/^\uFEFF/, '');
  const raw = JSON.parse(text);

  if (Array.isArray(raw)) {
    return {
      dataset: { samples: ensureIds(raw as TrainingSample[]), rejectedSamples: [], metadata: { migratedFrom: 'array' } },
      originalFormat: 'array'
    };
  }

  const samples = raw && Array.isArray(raw.samples) ? (raw.samples as TrainingSample[]) : [];
  const rejectedSamples = raw && Array.isArray(raw.rejectedSamples) ? raw.rejectedSamples : [];
  const metadata = raw && typeof raw.metadata === 'object' ? raw.metadata : {};

  return {
    dataset: { samples: ensureIds(samples), rejectedSamples, metadata },
    originalFormat: 'object'
  };
}

function readWeightsFile(filePath: string): { weights: Record<string, number[]> } | null {
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  const data = JSON.parse(text);
  if (data && typeof data === 'object' && (data as any).weights) return { weights: (data as any).weights };
  return { weights: data };
}

function saveWeightsToFile(brainNN: BrainNNAdapter, filePath: string, note: string): void {
  if (!fs.existsSync(CONFIG.WEIGHTS_DIR)) fs.mkdirSync(CONFIG.WEIGHTS_DIR, { recursive: true });
  const payload = {
    modelVersion: brainNN.getModelVersion(),
    timestamp: Date.now(),
    weights: brainNN.saveWeights(),
    metadata: { note }
  };
  writeJsonAtomic(filePath, payload);
}

async function backupWeights(brainNN: BrainNNAdapter): Promise<void> {
  console.log('[train] backing up current weights...');
  saveWeightsToFile(brainNN, CONFIG.BACKUP_PATH, 'auto backup before training');
  console.log(`[train] backup saved: ${CONFIG.BACKUP_PATH}`);
}

async function restoreWeights(brainNN: BrainNNAdapter): Promise<void> {
  console.log('[train] restoring weights from backup...');
  const backup = readWeightsFile(CONFIG.BACKUP_PATH);
  if (!backup) throw new Error(`Backup not found: ${CONFIG.BACKUP_PATH}`);
  brainNN.loadWeights(backup.weights);
  saveWeightsToFile(brainNN, CONFIG.WEIGHTS_PATH, 'rollback to backup');
  console.log('[train] weights restored');
}

function projectEmbedding(embedding: number[], targetDim: number): number[] {
  if (!Array.isArray(embedding)) return new Array(targetDim).fill(0);
  if (embedding.length === targetDim) return embedding;

  const projected = new Array(targetDim).fill(0);
  const scale = embedding.length / targetDim;
  for (let i = 0; i < targetDim; i++) {
    const idx = Math.floor(i * scale);
    projected[i] = embedding[Math.min(idx, embedding.length - 1)] || 0;
  }
  return projected;
}

function normalizeInputVector(input: number[]): number[] {
  if (input.length === CONFIG.INPUT_DIM) return input;
  if (input.length > CONFIG.INPUT_DIM) return input.slice(0, CONFIG.INPUT_DIM);
  const padded = new Array(CONFIG.INPUT_DIM).fill(0);
  for (let i = 0; i < input.length; i++) padded[i] = input[i] ?? 0;
  return padded;
}

function buildInputVector(sample: TrainingSample): number[] {
  const msg = projectEmbedding(sample.features?.messageEmbedding || [], CONFIG.PROJECTED_EMBED_DIM);
  const mem = projectEmbedding(sample.features?.memoryContextEmbedding || [], CONFIG.PROJECTED_EMBED_DIM);
  const input = [
    ...(sample.features?.stateVector || []),
    ...(sample.features?.perceptionVector || []),
    ...msg,
    ...mem
  ];
  return normalizeInputVector(input);
}

function classifySample(sample: TrainingSample): SampleLabel | null {
  const rating = sample.metadata?.manualRating;
  if (rating === POSITIVE_RATING) return 'positive';
  if (rating === NEGATIVE_RATING) return 'negative';

  const feedback = sample.label?.userFeedback;
  if (feedback === 'positive') return 'positive';
  if (feedback === 'negative') return 'negative';

  const wasRejected = sample.label?.wasRejected === true;
  const isNeg = wasRejected || sample.metadata?.isNegativeExample === true || sample.metadata?.isNegative === true;
  if (isNeg) return 'negative';

  const quality = typeof sample.metadata?.quality === 'number' ? sample.metadata!.quality! : 0.5;
  if (quality >= CONFIG.POSITIVE_MIN_QUALITY) return 'positive';

  return null;
}

function isUsableSample(sample: TrainingSample): boolean {
  const selected = sample.label?.selectedCandidate;
  if (!selected || typeof selected !== 'string') return false;
  if (ALLOWED_BEHAVIORS.indexOf(selected as BehaviorType) < 0) return false;
  if (!sample.features) return false;
  return true;
}

function getQuality(sample: TrainingSample): number {
  const quality = typeof sample.metadata?.quality === 'number' ? sample.metadata!.quality! : 0.5;
  if (!Number.isFinite(quality)) return 0.5;
  return Math.max(0, Math.min(1, quality));
}

function computeDatasetStats(samples: TrainingSample[], rejectedCount: number) {
  const usable = samples.filter(isUsableSample);
  const untrained = CONFIG.INCLUDE_TRAINED ? usable : usable.filter(s => s.metadata?.usedInTraining !== true);

  let labeled = 0;
  let positive = 0;
  let negative = 0;
  let qualitySum = 0;
  let qualityMin = 1;
  let qualityMax = 0;

  for (const sample of untrained) {
    const label = classifySample(sample);
    if (!label) continue;
    labeled++;
    if (label === 'positive') positive++;
    else negative++;

    const quality = getQuality(sample);
    qualitySum += quality;
    if (quality < qualityMin) qualityMin = quality;
    if (quality > qualityMax) qualityMax = quality;
  }

  return {
    total: samples.length,
    usable: usable.length,
    untrained: untrained.length,
    labeled,
    positive,
    negative,
    avgQuality: labeled > 0 ? qualitySum / labeled : 0,
    minQuality: labeled > 0 ? qualityMin : 0,
    maxQuality: labeled > 0 ? qualityMax : 0,
    rejected: rejectedCount
  };
}

function buildTargetVector(sample: TrainingSample, label: SampleLabel): number[] {
  const target = new Array(CONFIG.OUTPUT_DIM).fill(0);
  const selected = sample.label.selectedCandidate as BehaviorType;
  const selectedIndex = ALLOWED_BEHAVIORS.indexOf(selected);
  if (selectedIndex < 0) return target;

  if (label === 'positive') {
    target[selectedIndex] = 1;
    return target;
  }

  const scores = sample.label.candidateScores || {};
  let total = 0;
  for (let i = 0; i < ALLOWED_BEHAVIORS.length; i++) {
    const behavior = ALLOWED_BEHAVIORS[i];
    if (behavior === selected) continue;
    const score = typeof scores[behavior] === 'number' ? scores[behavior] : 0;
    target[i] = score;
    total += score;
  }

  if (total <= 0) {
    const uniform = 1 / Math.max(1, ALLOWED_BEHAVIORS.length - 1);
    for (let i = 0; i < ALLOWED_BEHAVIORS.length; i++) {
      if (i === selectedIndex) continue;
      target[i] = uniform;
    }
    return target;
  }

  for (let i = 0; i < ALLOWED_BEHAVIORS.length; i++) {
    target[i] = target[i] / total;
  }
  return target;
}

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function selectLabeledSamples(all: TrainingSample[]): Array<{ sample: TrainingSample; label: SampleLabel }> {
  const usable = all.filter(isUsableSample);
  const filtered = CONFIG.INCLUDE_TRAINED ? usable : usable.filter(s => s.metadata?.usedInTraining !== true);

  const positives: TrainingSample[] = [];
  const negatives: TrainingSample[] = [];

  for (const sample of filtered) {
    const label = classifySample(sample);
    if (!label) continue;
    if (label === 'positive') positives.push(sample);
    else negatives.push(sample);
  }

  shuffleInPlace(positives);
  shuffleInPlace(negatives);

  // 修复：当没有负样本时，直接使用正样本
  let selectedPos: TrainingSample[];
  let selectedNeg: TrainingSample[];
  
  if (negatives.length === 0) {
    // 无负样本模式：只用正样本
    selectedPos = positives.slice(0, CONFIG.MAX_SAMPLES);
    selectedNeg = [];
  } else {
    const maxNeg = Math.min(negatives.length, Math.floor(CONFIG.MAX_SAMPLES / (1 + CONFIG.POS_TO_NEG_RATIO)));
    selectedNeg = negatives.slice(0, maxNeg);
    selectedPos = positives.slice(0, Math.min(positives.length, maxNeg * CONFIG.POS_TO_NEG_RATIO));
  }

  const combined: Array<{ sample: TrainingSample; label: SampleLabel }> = [
    ...selectedNeg.map(sample => ({ sample, label: 'negative' as const })),
    ...selectedPos.map(sample => ({ sample, label: 'positive' as const }))
  ];

  shuffleInPlace(combined);
  return combined.slice(0, CONFIG.MAX_SAMPLES);
}

function splitTrainVal<T>(items: T[]): { train: T[]; val: T[] } {
  const total = items.length;
  const valSize = Math.max(1, Math.floor(total * CONFIG.VALIDATION_SPLIT));
  const trainSize = Math.max(1, total - valSize);
  return { train: items.slice(0, trainSize), val: items.slice(trainSize, trainSize + valSize) };
}

async function evaluateModel(
  brainNN: BrainNNAdapter,
  labeledSamples: Array<{ sample: TrainingSample; label: SampleLabel }>
): Promise<{ positiveScore: number; negativeScore: number; positiveCount: number; negativeCount: number }> {
  const candidateGenerator = new CandidateGenerator();
  let positiveScore = 0;
  let negativeScore = 0;
  let positiveCount = 0;
  let negativeCount = 0;

  for (const { sample, label } of labeledSamples) {
    const memoryContext = {
      memoryIds: [],
      scores: [],
      allowedSnippets: [],
      summaryEmbedding: sample.features.memoryContextEmbedding
    };

    const candidates = candidateGenerator.generateCandidates(
      ALLOWED_BEHAVIORS,
      memoryContext,
      0.5,
      { maxVerbosity: 1.0, maxSarcasm: 0.5, maxRecallStrength: 0.6 }
    );

    const riskHint = typeof sample.label.riskHint === 'number' ? sample.label.riskHint : 0;
    const perception = {
      sentiment: (sample.features.perceptionVector?.[0] ?? 0) * 2 - 1,
      intent: (sample.features.perceptionVector?.[1] ?? 0) > 0.5 ? 'question' : 'statement',
      riskHint,
      entities: [] as string[],
      confidence: 0.8
    };

    const innerState = {
      emotion: { joy: 0.5, sadness: 0.5, anger: 0.5, curiosity: 0.5, fatigue: 0.5 },
      persona: { energy: 0.5, talkativeness: 0.5, openness: 0.5, willingness: 0.5, mood: 'calm' as const },
      audience: { excited: 0.5, bored: 0.5, tense: 0.5 },
      conflict: { hesitation: 0.5, turmoil: 0.5, decisionDifficulty: 0.5 },
      mode: 'normal' as const
    };

    const policyOutput = await brainNN.evaluate(
      candidates,
      sample.features.stateVector,
      sample.features.perceptionVector,
      sample.features.messageEmbedding,
      sample.features.memoryContextEmbedding,
      perception as any,
      innerState as any,
      riskHint
    );

    const expectedBehavior = sample.label.selectedCandidate;
    const rawProb = policyOutput.candidateProbabilities[expectedBehavior];
    const probability = typeof rawProb === 'number' && Number.isFinite(rawProb) ? rawProb : 0;

    if (label === 'positive') {
      positiveScore += probability;
      positiveCount++;
    } else {
      negativeScore += probability;
      negativeCount++;
    }
  }

  return {
    positiveScore: positiveCount > 0 ? positiveScore / positiveCount : 0,
    negativeScore: negativeCount > 0 ? negativeScore / negativeCount : 0,
    positiveCount,
    negativeCount
  };
}

function buildTrainingBatch(
  labeledSamples: Array<{ sample: TrainingSample; label: SampleLabel }>
): Array<{ input: number[]; target: number[] }> {
  return labeledSamples.map(({ sample, label }) => ({
    input: buildInputVector(sample),
    target: buildTargetVector(sample, label)
  }));
}

async function runTraining(
  brainNN: BrainNNAdapter,
  labeledTrain: Array<{ sample: TrainingSample; label: SampleLabel }>
): Promise<void> {
  console.log(`[train] 🧠 BrainNN v5.0 training: epochs=${CONFIG.EPOCHS} lr=${CONFIG.LEARNING_RATE} batch=${CONFIG.BATCH_SIZE}`);
  const trainingBatch = buildTrainingBatch(labeledTrain);
  if (trainingBatch.length === 0) throw new Error('No usable training samples.');

  brainNN.setTraining(true);
  for (let epoch = 1; epoch <= CONFIG.EPOCHS; epoch++) {
    shuffleInPlace(trainingBatch);
    let totalLoss = 0;
    let totalCount = 0;
    for (let i = 0; i < trainingBatch.length; i += CONFIG.BATCH_SIZE) {
      const batch = trainingBatch.slice(i, i + CONFIG.BATCH_SIZE);
      const avgLoss = await brainNN.trainBatch(batch, CONFIG.LEARNING_RATE);
      if (!Number.isFinite(avgLoss)) {
        throw new Error(`Non-finite loss detected (avgLoss=${avgLoss}).`);
      }
      totalLoss += avgLoss * batch.length;
      totalCount += batch.length;
    }
    const epochLoss = totalCount > 0 ? totalLoss / totalCount : 0;
    if (!Number.isFinite(epochLoss)) {
      throw new Error(`Non-finite epoch loss detected (epochLoss=${epochLoss}).`);
    }
    console.log(`[train] epoch ${epoch}/${CONFIG.EPOCHS} avg_loss=${epochLoss.toFixed(6)}`);
  }
  brainNN.setTraining(false);
  console.log('[train] 🧠 BrainNN training finished');
}

function markSamplesAsTrained(dataset: DatasetObject, sampleIds: string[], modelVersion: string): void {
  const idSet = new Set(sampleIds);
  const now = Date.now();
  for (const sample of dataset.samples) {
    const sid = stableId(sample);
    if (!idSet.has(sid)) continue;
    if (!sample.metadata) sample.metadata = {};
    sample.metadata.usedInTraining = true;
    sample.metadata.trainedAt = now;
    sample.metadata.trainedModelVersion = modelVersion;
  }

  dataset.metadata = {
    ...(dataset.metadata || {}),
    lastTrainedAt: now,
    lastTrainedModelVersion: modelVersion,
    lastTrainedSampleCount: sampleIds.length
  };
}

async function trainOneClick(): Promise<void> {
  console.log('[train] 🧠 starting BrainNN v5.0 one-click training');

  let brainNN: BrainNNAdapter | null = null;
  let didBackup = false;

  try {
    const { dataset, originalFormat } = readDataset();
    console.log(`[train] dataset loaded format=${originalFormat} samples=${dataset.samples.length}`);

    const rejectedCount = Array.isArray(dataset.rejectedSamples) ? dataset.rejectedSamples.length : 0;
    const datasetStats = computeDatasetStats(dataset.samples, rejectedCount);

    const warnings: string[] = [];
    const gateErrors: string[] = [];

    if (datasetStats.labeled < CONFIG.MIN_SAMPLES) {
      gateErrors.push(`insufficient_samples(${datasetStats.labeled}<${CONFIG.MIN_SAMPLES})`);
    }
    if (datasetStats.positive < CONFIG.MIN_POSITIVE) {
      gateErrors.push(`insufficient_positive(${datasetStats.positive}<${CONFIG.MIN_POSITIVE})`);
    }
    if (datasetStats.negative < CONFIG.MIN_NEGATIVE) {
      gateErrors.push(`insufficient_negative(${datasetStats.negative}<${CONFIG.MIN_NEGATIVE})`);
    }
    if (datasetStats.avgQuality < CONFIG.MIN_AVG_QUALITY) {
      const note = `low_avg_quality(${datasetStats.avgQuality.toFixed(2)}<${CONFIG.MIN_AVG_QUALITY})`;
      warnings.push(note);
      if (CONFIG.FAIL_ON_LOW_QUALITY) gateErrors.push(note);
    }
    if (datasetStats.positive > 0 && datasetStats.negative > 0) {
      const ratio = datasetStats.positive / datasetStats.negative;
      if (ratio > CONFIG.POS_TO_NEG_RATIO * 2) {
        warnings.push(`imbalanced_ratio(pos/neg=${ratio.toFixed(2)})`);
      }
    }

    const reportBase = {
      timestamp: Date.now(),
      status: 'skipped',
      reason: '',
      warnings,
      dataset: datasetStats,
      format: originalFormat,
      config: {
        epochs: CONFIG.EPOCHS,
        learningRate: CONFIG.LEARNING_RATE,
        batchSize: CONFIG.BATCH_SIZE,
        minSamples: CONFIG.MIN_SAMPLES,
        minPositive: CONFIG.MIN_POSITIVE,
        minNegative: CONFIG.MIN_NEGATIVE,
        maxSamples: CONFIG.MAX_SAMPLES,
        validationSplit: CONFIG.VALIDATION_SPLIT
      },
      isSuccess: false
    };

    if (gateErrors.length > 0) {
      reportBase.reason = gateErrors.join('; ');
      writeJsonAtomic(CONFIG.REPORT_PATH, reportBase);
      console.log(`[train] skipped: ${reportBase.reason}`);
      return;
    }

    if (warnings.length > 0) {
      console.warn(`[train] warnings: ${warnings.join('; ')}`);
    }

    const labeled = selectLabeledSamples(dataset.samples);
    const pos = labeled.filter(x => x.label === 'positive').length;
    const neg = labeled.filter(x => x.label === 'negative').length;

    // 修改：允许无负样本训练（只要有足够正样本）
    if (pos === 0 || labeled.length === 0) {
      reportBase.reason = `insufficient_labeled(pos=${pos}, neg=${neg}, total=${labeled.length})`;
      writeJsonAtomic(CONFIG.REPORT_PATH, reportBase);
      console.log(`[train] skipped: ${reportBase.reason}`);
      return;
    }
    if (neg === 0 && CONFIG.MIN_NEGATIVE > 0) {
      reportBase.reason = `insufficient_negative(neg=${neg}, required=${CONFIG.MIN_NEGATIVE})`;
      writeJsonAtomic(CONFIG.REPORT_PATH, reportBase);
      console.log(`[train] skipped: ${reportBase.reason}`);
      return;
    }
    if (labeled.length < CONFIG.MIN_SAMPLES) {
      reportBase.reason = `insufficient_samples_selected(${labeled.length}<${CONFIG.MIN_SAMPLES})`;
      writeJsonAtomic(CONFIG.REPORT_PATH, reportBase);
      console.log(`[train] skipped: ${reportBase.reason}`);
      return;
    }

    console.log(`[train] selected samples=${labeled.length} positive=${pos} negative=${neg}`);

    const { train: trainSet, val: valSet } = splitTrainVal(labeled);
    console.log(`[train] split train=${trainSet.length} val=${valSet.length}`);

    console.log('[train] 🧠 initializing BrainNN v5.0...');
    brainNN = getBrainNNAdapter({ weightsPath: CONFIG.WEIGHTS_PATH });

    const currentWeights = readWeightsFile(CONFIG.WEIGHTS_PATH);
    if (currentWeights) {
      // BrainNN v5.0 权重结构检查
      const weightsData = currentWeights.weights as any;
      const isBrainNNWeights = weightsData.version?.includes('v5') || 
                               weightsData.inputFusion !== undefined ||
                               weightsData.transformer !== undefined;
      
      if (isBrainNNWeights) {
        brainNN.loadWeights(weightsData);
        console.log('[train] 🧠 loaded existing BrainNN v5.0 weights');
      } else {
        console.log('[train] 🧠 found legacy weights, starting fresh with BrainNN v5.0 architecture');
      }
    } else {
      console.log('[train] 🧠 using fresh BrainNN v5.0 weights');
    }

    await backupWeights(brainNN);
    didBackup = true;

    console.log('[train] evaluating before training...');
    const beforeMetrics = await evaluateModel(brainNN, valSet);
    console.log(`[train] before positive=${(beforeMetrics.positiveScore * 100).toFixed(2)}% (${beforeMetrics.positiveCount})`);
    console.log(`[train] before negative=${(beforeMetrics.negativeScore * 100).toFixed(2)}% (${beforeMetrics.negativeCount})`);

    await runTraining(brainNN, trainSet);

    console.log('[train] evaluating after training...');
    const afterMetrics = await evaluateModel(brainNN, valSet);
    console.log(`[train] after positive=${(afterMetrics.positiveScore * 100).toFixed(2)}% (${afterMetrics.positiveCount})`);
    console.log(`[train] after negative=${(afterMetrics.negativeScore * 100).toFixed(2)}% (${afterMetrics.negativeCount})`);
;

    const positiveImprovement = afterMetrics.positiveScore - beforeMetrics.positiveScore;
    const negativeImprovement = beforeMetrics.negativeScore - afterMetrics.negativeScore;

    console.log('[train] improvement summary (validation set)');
    console.log(`[train] positive_delta=${(positiveImprovement * 100).toFixed(2)}%`);
    console.log(`[train] negative_delta=${(negativeImprovement * 100).toFixed(2)}%`);

    const acceptPositiveMin = parseFloat(process.env.TRAINING_ACCEPT_POSITIVE_DELTA_MIN || '0');
    const acceptNegativeMin = parseFloat(process.env.TRAINING_ACCEPT_NEGATIVE_DELTA_MIN || '0');
    const isSuccess =
      Number.isFinite(beforeMetrics.positiveScore) &&
      Number.isFinite(beforeMetrics.negativeScore) &&
      Number.isFinite(afterMetrics.positiveScore) &&
      Number.isFinite(afterMetrics.negativeScore) &&
      Number.isFinite(positiveImprovement) &&
      Number.isFinite(negativeImprovement) &&
      positiveImprovement >= acceptPositiveMin &&
      negativeImprovement >= acceptNegativeMin;

    const usedSampleIds = labeled.map(({ sample }) => stableId(sample));
    const report = {
      ...reportBase,
      status: isSuccess ? 'trained' : 'failed',
      reason: isSuccess ? '' : 'quality_gate',
      selected: { total: labeled.length, positive: pos, negative: neg },
      split: { train: trainSet.length, val: valSet.length },
      beforeMetrics,
      afterMetrics,
      improvements: { positive: positiveImprovement, negative: negativeImprovement },
      isSuccess,
      sampleIdsUsed: usedSampleIds.slice(0, 5000)
    };

    if (isSuccess) {
      saveWeightsToFile(brainNN, CONFIG.WEIGHTS_PATH, 'BrainNN v5.0 training success');
      console.log(`[train] 🧠 weights saved: ${CONFIG.WEIGHTS_PATH}`);

      markSamplesAsTrained(dataset, usedSampleIds, brainNN.getModelVersion());
      writeJsonAtomic(CONFIG.SAMPLES_PATH, dataset);
      console.log(`[train] dataset updated (marked trained): ${CONFIG.SAMPLES_PATH}`);

      writeJsonAtomic(CONFIG.REPORT_PATH, report);
      console.log(`[train] report saved: ${CONFIG.REPORT_PATH}`);

      console.log('[train] 🧠 BrainNN v5.0 training complete');
      return;
    }

    console.log('[train] training failed, restoring backup...');
    if (didBackup && brainNN) {
      await restoreWeights(brainNN);
    }
    writeJsonAtomic(CONFIG.REPORT_PATH, report);
    console.log(`[train] report saved: ${CONFIG.REPORT_PATH}`);
    console.log('[train] rollback completed');
    process.exit(1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[train] error:', message);
    const report = {
      timestamp: Date.now(),
      status: 'failed',
      reason: message,
      isSuccess: false
    };
    writeJsonAtomic(CONFIG.REPORT_PATH, report);
    if (didBackup && brainNN) {
      try {
        await restoreWeights(brainNN);
      } catch (rollbackError) {
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        console.error('[train] rollback error:', rollbackMessage);
      }
    }
    console.log('[train] you can rollback via: npm run train:rollback');
    process.exit(1);
  }
}

if (require.main === module) {
  trainOneClick();
}

export { trainOneClick, TrainingSample };
