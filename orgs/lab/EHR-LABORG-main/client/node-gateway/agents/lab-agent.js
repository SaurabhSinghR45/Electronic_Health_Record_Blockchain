'use strict';

/**
 * Lab Report Analysis Agent
 * Author: Saurabh Singh
 * Module: Module A (Lab Report Ingestion & Abnormality Triage)
 * 
 * Pipeline:
 * Lab Report Input
 *         ↓
 * Input Validation / Normalization
 *         ↓
 * Existing Gemini-based Lab Analysis (Reused from ai-agent.js)
 *         ↓
 * Structured Lab Findings (Novelty 1: Evidence Grounding)
 *         ↓
 * Deterministic Output Validation (Novelty 2: Range & Contradiction Checking)
 *         ↓
 * Standardized AgentResult
 */

const {
  getAiAgentConfig,
  callGeminiJson,
  buildLabReportPrompt,
  fallbackLabReportAnalysis,
  runLabReportAnalysisAgent,
  normalizeReportText,
  trimReportTextForPrompt,
  toSafeJson,
  normalizeToArray,
} = require('../ai-agent');

let AgentResult;
let AgentStatus;
try {
  const contract = require('../orchestrator/agent-contract');
  AgentResult = contract.AgentResult;
  AgentStatus = contract.AgentStatus;
} catch (_err) {
  AgentStatus = {
    SUCCESS: 'SUCCESS',
    FALLBACK: 'FALLBACK',
    ERROR: 'ERROR',
  };
  AgentResult = class FallbackAgentResult {
    constructor(props) {
      Object.assign(this, props);
    }
  };
}

const AGENT_ID = 'lab-agent';
const CLINICAL_DISCLAIMER =
  'Assistive lab analysis only. Must be clinically correlated by a licensed clinician; not a medical diagnosis or prescription.';

/**
 * Normalizes varied input shapes (standardized context or flat structure).
 * @param {object} context - Context object from orchestrator or direct caller.
 * @returns {object} Normalized input payload.
 */
function normalizeLabInput(context) {
  if (!context || typeof context !== 'object') {
    return {
      isValid: false,
      error: 'Context must be a non-null object',
      runId: `RUN-${Date.now()}`,
      patientId: 'unknown',
      requestingAgent: 'direct',
      metadata: {},
      testCode: '',
      resultData: null,
      reportText: '',
      reportTextSource: '',
    };
  }

  const isNested = Boolean(context.input && typeof context.input === 'object');
  const inputSource = isNested ? context.input : context;

  const runId = String(context.runId || `RUN-${Date.now()}`).trim();
  const patientId = String(context.patientId || inputSource.patientId || 'unknown').trim();
  const requestingAgent = String(context.requestingAgent || 'direct').trim();
  const metadata = (context.metadata && typeof context.metadata === 'object') ? { ...context.metadata } : {};

  const testCode = String(inputSource.testCode || context.testCode || '').trim();
  const reportTextSource = String(inputSource.reportTextSource || context.reportTextSource || '').trim();
  const reportText = normalizeReportText(inputSource.reportText || context.reportText || '');
  const resultData = inputSource.resultData !== undefined ? inputSource.resultData : context.resultData;

  const hasResultData = resultData !== null && resultData !== undefined && (
    (typeof resultData === 'object' && Object.keys(resultData).length > 0) ||
    (typeof resultData === 'string' && resultData.trim().length > 0)
  );
  const hasReportText = reportText.length > 0;

  const isValid = hasResultData || hasReportText;

  return {
    isValid,
    error: isValid ? null : 'No report text or structured resultData provided for analysis.',
    runId,
    patientId,
    requestingAgent,
    metadata,
    testCode,
    resultData: hasResultData ? resultData : null,
    reportText,
    reportTextSource,
  };
}

/**
 * Parses numeric value from a string or number safely.
 * @param {any} val - Value to parse.
 * @returns {number|null} Parsed number or null.
 */
function parseNumericValue(val) {
  if (typeof val === 'number' && !Number.isNaN(val)) {
    return val;
  }
  if (!val) {
    return null;
  }
  const cleanStr = String(val).replace(/,/g, '').trim();
  const match = cleanStr.match(/[-+]?[0-9]*\.?[0-9]+/);
  if (match) {
    const num = parseFloat(match[0]);
    return Number.isNaN(num) ? null : num;
  }
  return null;
}

/**
 * Parses a reference range string into lower and upper bounds.
 * Handles formats: "13.5-17.5", "13.5 - 17.5 g/dL", "< 200", "> 40", "4,500-11,000"
 * @param {string} rangeStr - Reference range text.
 * @returns {{ type: 'interval'|'upper'|'lower'|'unknown', low: number|null, high: number|null }}
 */
function parseReferenceRange(rangeStr) {
  if (!rangeStr || typeof rangeStr !== 'string') {
    return { type: 'unknown', low: null, high: null };
  }

  const clean = rangeStr.replace(/,/g, '').trim();

  // Pattern: "< 200" or "<= 200"
  const upperMatch = clean.match(/^(?:<=?|<)\s*([0-9]*\.?[0-9]+)/i);
  if (upperMatch) {
    return { type: 'upper', low: null, high: parseFloat(upperMatch[1]) };
  }

  // Pattern: "> 40" or ">= 40"
  const lowerMatch = clean.match(/^(?:>=?|>)\s*([0-9]*\.?[0-9]+)/i);
  if (lowerMatch) {
    return { type: 'lower', low: parseFloat(lowerMatch[1]), high: null };
  }

  // Pattern: "13.5 - 17.5" or "13.5-17.5"
  const intervalMatch = clean.match(/([0-9]*\.?[0-9]+)\s*(?:-|to)\s*([0-9]*\.?[0-9]+)/i);
  if (intervalMatch) {
    const low = parseFloat(intervalMatch[1]);
    const high = parseFloat(intervalMatch[2]);
    return { type: 'interval', low, high };
  }

  return { type: 'unknown', low: null, high: null };
}

/**
 * Searches report text for verbatim occurrence of a test finding to ground evidence.
 * @param {string} test - Name of test.
 * @param {string|number} value - Value of test.
 * @param {string} reportText - Full report text.
 * @returns {string|null} Grounded line from report text or null.
 */
function findVerbatimEvidence(test, value, reportText) {
  if (!reportText) {
    return null;
  }

  const lines = reportText.split('\n');
  const testTokens = String(test).toLowerCase().split(/[\s_-]+/).filter((t) => t.length > 2);
  const valStr = String(value).trim();

  for (const line of lines) {
    const lowerLine = line.toLowerCase();
    const hasValue = valStr.length > 0 && line.includes(valStr);
    const matchesTest = testTokens.some((tok) => lowerLine.includes(tok));

    if (hasValue && matchesTest) {
      return line.trim();
    }
  }

  for (const line of lines) {
    const lowerLine = line.toLowerCase();
    if (testTokens.some((tok) => lowerLine.includes(tok))) {
      return line.trim();
    }
  }

  return null;
}

/**
 * Heuristic extractor to build structured findings with evidence grounding
 * when Gemini is unconfigured or in offline fallback mode.
 * @param {string} reportText - Extracted text.
 * @param {object|null} resultData - Structured result data.
 * @returns {Array<object>} Structured findings array.
 */
function extractHeuristicFindings(reportText, resultData) {
  const findings = [];
  const seenTests = new Set();

  // 1. Extract from reportText line-by-line using clinical regex
  if (reportText) {
    const lines = reportText.split('\n');
    const lineRegex = /^\s*([A-Za-z0-9@#\s_-]+?)\s*:\s*([<>]?\s*[0-9,]+(?:\.[0-9]+)?)\s*([A-Za-z/%μuL]+)?(?:\s*[\(\[]?(?:Reference|Ref|R@f)?[:\s]*([0-9,.<>\s-]+(?:\s*[A-Za-z/%μuL]+)?)[\)\]]?)?/i;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.toLowerCase().startsWith('patient') || trimmed.toLowerCase().startsWith('impression')) {
        continue;
      }

      const match = trimmed.match(lineRegex);
      if (match) {
        const rawTest = match[1].replace(/[@#]/g, '').trim();
        const rawVal = match[2].trim();
        const unit = (match[3] || '').trim();
        const refRange = (match[4] || '').trim();

        if (rawTest.length >= 2 && !seenTests.has(rawTest.toLowerCase())) {
          seenTests.add(rawTest.toLowerCase());
          const numVal = parseNumericValue(rawVal);
          const rangeInfo = parseReferenceRange(refRange);
          let interpretation = 'normal';

          if (numVal !== null) {
            if (rangeInfo.type === 'interval') {
              if (numVal < rangeInfo.low) interpretation = 'below_reference';
              else if (numVal > rangeInfo.high) interpretation = 'above_reference';
            } else if (rangeInfo.type === 'upper' && numVal > rangeInfo.high) {
              interpretation = 'above_reference';
            } else if (rangeInfo.type === 'lower' && numVal < rangeInfo.low) {
              interpretation = 'below_reference';
            } else if (rangeInfo.type === 'unknown') {
              interpretation = 'inconclusive';
            }
          } else {
            interpretation = 'inconclusive';
          }

          findings.push({
            test: rawTest,
            value: numVal !== null ? numVal : rawVal,
            unit: unit || 'N/A',
            referenceRange: refRange || 'Not provided',
            interpretation,
            evidence: trimmed,
          });
        }
      }
    }
  }

  // 2. Extract from structured resultData if not already found in report text
  if (resultData && typeof resultData === 'object' && !Array.isArray(resultData)) {
    for (const [key, val] of Object.entries(resultData)) {
      const cleanKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      const alreadyCaptured = Array.from(seenTests).some((t) => {
        const cleanSeen = t.toLowerCase().replace(/[^a-z0-9]/g, '');
        return cleanSeen.includes(cleanKey) || cleanKey.includes(cleanSeen);
      });

      if (alreadyCaptured || key === 'reportFile' || key === 'storage' || key === 'rawOcrStatus') {
        continue;
      }
      seenTests.add(key.toLowerCase());
      const valStr = String(val);
      const numVal = parseNumericValue(valStr);
      const unitMatch = valStr.match(/[a-zA-Z/%μuL]+/);
      const unit = unitMatch ? unitMatch[0] : 'N/A';

      findings.push({
        test: key.replace(/_/g, ' '),
        value: numVal !== null ? numVal : valStr,
        unit,
        referenceRange: 'Not provided',
        interpretation: 'inconclusive',
        evidence: `resultData.${key}: "${valStr}"`,
      });
    }
  }

  return findings;
}

/**
 * NOVELTY 2: Deterministic Output Validation
 * Checks:
 * 1. Required fields
 * 2. Confidence within {'high', 'medium', 'low'}
 * 3. Array types for abnormalities and riskFlags
 * 4. Finding structure and evidence grounding
 * 5. Numerical reference range contradiction detection
 * 6. Medical safety guardrail (no definitive diagnosis/prescription)
 * 
 * @param {object} rawOutput - Output from Gemini or fallback.
 * @param {string} reportText - Raw report text.
 * @param {any} resultData - Raw result data.
 * @returns {{ sanitizedResult: object, confidence: string, errors: Array<string>, warnings: Array<string> }}
 */
function validateLabFindings(rawOutput, reportText, resultData) {
  const errors = [];
  const warnings = [];
  let confidence = String(rawOutput.confidence || 'low').toLowerCase();

  if (!['high', 'medium', 'low'].includes(confidence)) {
    warnings.push(`Invalid confidence "${confidence}" detected. Adjusted to "low".`);
    confidence = 'low';
  }

  const summary = String(rawOutput.summary || '').trim() || 'No summary generated.';
  const abnormalities = normalizeToArray(rawOutput.abnormalities).map((item) => String(item).trim()).filter(Boolean);
  const riskFlags = normalizeToArray(rawOutput.riskFlags).map((item) => String(item).trim()).filter(Boolean);

  let rawFindings = normalizeToArray(rawOutput.findings);

  // If Gemini produced no findings, derive them via deterministic extractor
  if (rawFindings.length === 0) {
    rawFindings = extractHeuristicFindings(reportText, resultData);
  }

  const validatedFindings = [];

  for (const item of rawFindings) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const test = String(item.test || '').trim();
    if (!test) {
      continue;
    }

    const value = item.value !== undefined ? item.value : null;
    const unit = String(item.unit || 'N/A').trim();
    const referenceRange = String(item.referenceRange || 'Not provided').trim();
    let interpretation = String(item.interpretation || 'inconclusive').toLowerCase().trim();

    // Standardize interpretation
    const validInterpretations = ['normal', 'below_reference', 'above_reference', 'abnormal', 'inconclusive'];
    if (!validInterpretations.includes(interpretation)) {
      if (interpretation.includes('low') || interpretation.includes('below')) {
        interpretation = 'below_reference';
      } else if (interpretation.includes('high') || interpretation.includes('above') || interpretation.includes('elevated')) {
        interpretation = 'above_reference';
      } else if (interpretation.includes('norm')) {
        interpretation = 'normal';
      } else {
        interpretation = 'inconclusive';
      }
    }

    // Novelty 1: Evidence Grounding Validation
    let evidence = item.evidence ? String(item.evidence).trim() : null;
    if (evidence) {
      // Check if evidence is grounded in report text or resultData
      const inText = reportText && reportText.includes(evidence);
      const inData = resultData && toSafeJson(resultData).includes(evidence);

      if (!inText && !inData) {
        // Find best verbatim line in report text rather than accepting hallucinated evidence
        const groundedLine = findVerbatimEvidence(test, value, reportText);
        if (groundedLine) {
          evidence = groundedLine;
        } else {
          warnings.push(`Evidence for test "${test}" was not found verbatim in input; ungrounded evidence removed.`);
          evidence = null;
        }
      }
    } else {
      // Try to ground evidence automatically from source text
      evidence = findVerbatimEvidence(test, value, reportText);
    }

    // Novelty 2: Contradiction Detection against Reference Range
    const numericValue = parseNumericValue(value);
    const rangeInfo = parseReferenceRange(referenceRange);

    if (numericValue !== null && rangeInfo.type !== 'unknown') {
      let expectedInterpretation = null;

      if (rangeInfo.type === 'interval') {
        if (numericValue < rangeInfo.low) {
          expectedInterpretation = 'below_reference';
        } else if (numericValue > rangeInfo.high) {
          expectedInterpretation = 'above_reference';
        } else {
          expectedInterpretation = 'normal';
        }
      } else if (rangeInfo.type === 'upper') {
        expectedInterpretation = numericValue > rangeInfo.high ? 'above_reference' : 'normal';
      } else if (rangeInfo.type === 'lower') {
        expectedInterpretation = numericValue < rangeInfo.low ? 'below_reference' : 'normal';
      }

      if (expectedInterpretation && interpretation !== expectedInterpretation && interpretation !== 'abnormal') {
        const contradictionMsg = `Contradiction detected for "${test}": value ${numericValue} vs reference range "${referenceRange}" indicates "${expectedInterpretation}", but model reported "${interpretation}". Corrected to "${expectedInterpretation}".`;
        errors.push(contradictionMsg);
        interpretation = expectedInterpretation;

        // Lower confidence upon contradiction
        if (confidence === 'high') {
          confidence = 'medium';
        }
      }
    }

    validatedFindings.push({
      test,
      value: numericValue !== null ? numericValue : value,
      unit,
      referenceRange,
      interpretation,
      evidence,
    });
  }

  // Medical Safety Guardrail: check for definitive diagnostic terms
  const safetyRegex = /\b(?:diagnosed with|confirmed diagnosis of|prescribe|prescribed|take \d+\s*mg)\b/i;
  if (safetyRegex.test(summary)) {
    warnings.push('Summary contained assertive diagnostic/prescriptive phrasing. Assistive framing reinforced.');
  }

  const sanitizedResult = {
    summary,
    findings: validatedFindings,
    abnormalities,
    riskFlags,
    modelUsed: rawOutput.modelUsed || 'none',
    source: rawOutput.source || 'gemini',
  };

  return {
    sanitizedResult,
    confidence,
    errors,
    warnings,
  };
}

/**
 * Main Execution Function for Lab Report Analysis Agent.
 * Reuses existing Gemini logic, handles model fallback and heuristic fallback,
 * performs evidence grounding and deterministic validation.
 * 
 * @param {object} context - Agent input context.
 * @returns {Promise<object>} Standardized AgentResult.
 */
async function execute(context) {
  const norm = normalizeLabInput(context);

  if (!norm.isValid) {
    return new AgentResult({
      agentId: AGENT_ID,
      status: AgentStatus.ERROR || 'ERROR',
      result: {
        summary: 'Input validation failed: No report text or structured resultData provided.',
        findings: [],
        abnormalities: [],
        riskFlags: [],
        modelUsed: 'none',
        source: 'validation-failure',
      },
      confidence: 'low',
      errors: [norm.error],
      metadata: {
        runId: norm.runId,
        patientId: norm.patientId,
        requestingAgent: norm.requestingAgent,
        executionMode: 'input-validation',
        timestamp: new Date().toISOString(),
        disclaimer: CLINICAL_DISCLAIMER,
      },
    });
  }

  const config = getAiAgentConfig();
  let rawOutput = null;
  let executionMode = 'gemini';
  const pipelineErrors = [];

  // If Gemini is unconfigured, immediately route to fallback heuristic
  if (!config.configured) {
    executionMode = 'fallback-heuristic';
    const heuristic = fallbackLabReportAnalysis(norm.resultData, norm.reportText);
    rawOutput = {
      ...heuristic,
      modelUsed: 'none',
      source: 'fallback-heuristic',
      confidence: 'low',
      findings: extractHeuristicFindings(norm.reportText, norm.resultData),
    };
  } else {
    try {
      rawOutput = await runLabReportAnalysisAgent({
        resultData: norm.resultData,
        testCode: norm.testCode,
        patientId: norm.patientId,
        reportText: norm.reportText,
        reportTextSource: norm.reportTextSource,
        requestFindings: true,
      });
    } catch (geminiError) {
      executionMode = 'fallback-heuristic';
      pipelineErrors.push(`Gemini API call failed: ${geminiError.message}`);
      const heuristic = fallbackLabReportAnalysis(norm.resultData, norm.reportText);
      rawOutput = {
        ...heuristic,
        modelUsed: 'none',
        source: 'fallback-heuristic',
        confidence: 'low',
        findings: extractHeuristicFindings(norm.reportText, norm.resultData),
      };
    }
  }

  // Deterministic Validation & Evidence Grounding
  const validation = validateLabFindings(rawOutput, norm.reportText, norm.resultData);
  const allErrors = [...pipelineErrors, ...validation.errors];

  return new AgentResult({
    agentId: AGENT_ID,
    status: executionMode === 'fallback-heuristic' ? (AgentStatus.FALLBACK || 'FALLBACK') : AgentStatus.SUCCESS,
    result: {
      summary: validation.sanitizedResult.summary,
      findings: validation.sanitizedResult.findings,
      abnormalities: validation.sanitizedResult.abnormalities,
      riskFlags: validation.sanitizedResult.riskFlags,
      modelUsed: validation.sanitizedResult.modelUsed,
      source: validation.sanitizedResult.source,
    },
    confidence: validation.confidence,
    errors: allErrors,
    metadata: {
      runId: norm.runId,
      patientId: norm.patientId,
      testCode: norm.testCode,
      reportTextSource: norm.reportTextSource,
      timestamp: new Date().toISOString(),
      executionMode,
      modelConfigured: config.configured,
      modelRequested: config.model,
      validationWarnings: validation.warnings,
      disclaimer: CLINICAL_DISCLAIMER,
      ...norm.metadata,
    },
  });
}

async function runLabAgent(context, inputPayload) {
  const mergedContext = {
    ...(context && typeof context === 'object' ? context : {}),
    input: inputPayload || (context && context.input) || context,
  };
  return await execute(mergedContext);
}

module.exports = {
  execute,
  executeLabAgent: execute,
  runLabAgent,
  normalizeLabInput,
  parseNumericValue,
  parseReferenceRange,
  findVerbatimEvidence,
  extractHeuristicFindings,
  validateLabFindings,
  CLINICAL_DISCLAIMER,
};
