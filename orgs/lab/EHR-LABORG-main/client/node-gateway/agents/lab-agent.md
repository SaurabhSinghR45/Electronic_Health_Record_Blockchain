# Lab Report Analysis Agent (Module A)

**Author:** Saurabh Singh  
**Component:** Multi-Agent EHR Architecture — Lab Module  
**Scope:** Lab Report Ingestion & Abnormality Triage (Machine 1)  
**File Location:** `orgs/lab/EHR-LABORG-main/client/node-gateway/agents/lab-agent.js`

---

## 1. What the Lab Report Analysis Agent Does
The **Lab Report Analysis Agent** is a dedicated clinical ingestion and triage agent. It parses incoming laboratory reports (extracted OCR/PDF text and structured test data), identifies numerical test findings, checks them against standard or provided laboratory reference intervals, flags abnormalities, and surfaces risk alerts for clinician review.

---

## 2. Why It Exists
In high-throughput healthcare environments, diagnostic reports arrive in diverse formats: structured JSON payloads, formatted PDFs, and noisy OCR scans from faxed physical paper. 

Doctors and clinicians face cognitive fatigue reviewing pages of dense tabular values. The Lab Agent provides automated, assistive first-pass triage by:
1. Normalizing unstructured or heterogeneous inputs.
2. Highlighting critical out-of-range values instantly.
3. Anchoring every flagged finding with verbatim text evidence for auditability.
4. Catching potential AI hallucinations or contradictions before outputs reach human clinicians or downstream agents.

---

## 3. Input Contract
The agent accepts a standardized agent context object from an orchestrator, while remaining backward-compatible with legacy flat parameters:

### Standardized Format (Recommended):
```json
{
  "runId": "RUN-001",
  "patientId": "patient-1001",
  "requestingAgent": "ORCHESTRATOR",
  "metadata": {},
  "input": {
    "testCode": "CBC",
    "resultData": {
      "hemoglobin": "9.2 g/dL",
      "rbc": "3.1 million/uL",
      "wbc": "11,500 /uL",
      "platelets": "140,000 /uL"
    },
    "reportText": "COMPLETE BLOOD COUNT (CBC)\nPatient: patient-1001\nHemoglobin: 9.2 g/dL (Reference: 13.5-17.5)\nRBC Count: 3.1 million/uL (Reference: 4.5-5.9)\nWBC Count: 11,500 /uL (Reference: 4,500-11,000)\nPlatelets: 140,000 /uL (Reference: 150,000-450,000)",
    "reportTextSource": "cbc-lab-report.pdf"
  }
}
```

### Flat Format (Tolerated for Backward Compatibility):
```json
{
  "patientId": "patient-1001",
  "testCode": "CBC",
  "resultData": { "hemoglobin": "9.2 g/dL" },
  "reportText": "Hemoglobin: 9.2 g/dL (Reference: 13.5-17.5)",
  "reportTextSource": "cbc-lab-report.pdf"
}
```

---

## 4. Output Contract (Standardized AgentResult)
The agent outputs a predictable, strictly validated `AgentResult`:

```json
{
  "agentId": "lab-agent",
  "status": "SUCCESS",
  "result": {
    "summary": "Hemoglobin (9.2 g/dL) and RBC count are below adult reference ranges, alongside mild leukocytosis.",
    "findings": [
      {
        "test": "Hemoglobin",
        "value": 9.2,
        "unit": "g/dL",
        "referenceRange": "13.5-17.5",
        "interpretation": "below_reference",
        "evidence": "Hemoglobin: 9.2 g/dL (Reference: 13.5-17.5)"
      }
    ],
    "abnormalities": [
      "Low hemoglobin (9.2 g/dL vs ref 13.5-17.5 g/dL)"
    ],
    "riskFlags": [
      "Possible anemia pattern"
    ],
    "modelUsed": "gemini-2.5-flash",
    "source": "gemini"
  },
  "confidence": "high",
  "errors": [],
  "metadata": {
    "runId": "RUN-001",
    "patientId": "patient-1001",
    "testCode": "CBC",
    "timestamp": "2026-09-28T00:50:00.000Z",
    "executionMode": "gemini",
    "disclaimer": "Assistive lab analysis only. Must be clinically correlated by a licensed clinician; not a medical diagnosis or prescription."
  }
}
```

---

## 5. Processing Pipeline

```
          [ Laboratory Report Input ]
          (JSON, PDF text, OCR scan)
                      │
                      ▼
         [ Input Normalization Layer ]
       (Validates presence, unifies schema)
                      │
                      ▼
         [ Reused Gemini Core Logic ]
         (Model cascade: 2.5 Flash →
         2.5 Flash Lite → 2.0 Flash)
         [ Or Fallback Heuristics ]
                      │
                      ▼
      [ Novelty 1: Evidence Grounding ]
    (Extracts test, value, unit, refRange,
     attaches verbatim source evidence line)
                      │
                      ▼
     [ Novelty 2: Deterministic Validator ]
   (Verifies bounds, catches AI contradictions,
    detects hallucinations, adjusts confidence)
                      │
                      ▼
        [ Standardized AgentResult ]
```

---

## 6. How Existing Gemini Code Is Reused
To avoid unnecessary code duplication and honor repo architecture:
* **No duplicated HTTP/Fetch logic:** Reuses `callGeminiJson()` from `ai-agent.js`.
* **No duplicated fallback cascades:** Reuses model retry cascade (`gemini-2.5-flash` → `gemini-2.5-flash-lite` → `gemini-2.0-flash` → `gemini-1.5-flash`).
* **No duplicated prompt logic:** Extends `buildLabReportPrompt()` and `runLabReportAnalysisAgent()` with clean optional parameters for structured findings.
* **No duplicated heuristics:** Leverages `fallbackLabReportAnalysis()` when offline.

---

## 7. Novelty 1: Evidence-Grounded Findings
LLMs are prone to hallucinating lab values or referencing phantom data. The Lab Agent introduces **Evidence Grounding**:
* Every extracted finding must carry an `evidence` field containing the verbatim source excerpt from the uploaded report.
* If Gemini proposes a finding with an evidence string that does not match the actual report text, the agent searches the source text for the real line or strips the ungrounded evidence (`evidence: null`), ensuring full explainability and medical safety.

---

## 8. Novelty 2: Deterministic Validation
A lightweight algorithmic guardrail runs after the LLM returns its output:
1. **Schema Check:** Ensures `summary`, `findings`, `abnormalities`, and `riskFlags` exist with proper data types.
2. **Confidence Bounds:** Limits confidence to `high | medium | low`.
3. **Contradiction Detection:**
   * Parses numerical test values (e.g. `9.2`).
   * Parses reference intervals (e.g. `13.5-17.5`, `< 200`, `> 40`).
   * If the report shows `Hemoglobin: 9.2 g/dL (Reference: 13.5-17.5)` but the LLM hallucinates an interpretation of `"normal"`, the validator catches the mathematical contradiction, corrects the interpretation to `"below_reference"`, logs an explicit validation error, and downgrades confidence.

---

## 9. Confidence Handling
* **`high`:** Gemini inference succeeded, all findings are grounded in report text, and no contradictions were detected.
* **`medium`:** Gemini inference succeeded, but a contradiction was detected and deterministically corrected, or noise was present.
* **`low`:** Offline heuristic fallback was used, reference ranges were unavailable, or input was partially corrupted.

---

## 10. Gemini Fallback
If:
* `GEMINI_API_KEY` is not configured,
* Google Generative Language API is unreachable,
* Rate limits (HTTP 429) or internal server errors occur,
* Gemini returns invalid JSON,

the agent does **not** crash. It gracefully switches to `executionMode: "fallback-heuristic"`, runs deterministic regex extraction with `confidence: "low"`, sets `status: "FALLBACK"`, and clearly indicates `source: "fallback-heuristic"`.

---

## 11. Mock Testing & Standalone Execution
The agent does not require Hyperledger Fabric, IPFS, Docker, or external network connections to run:
* **Unit Tests:** `node agents/lab-agent.test.js` (10 comprehensive tests covering normal, abnormal, missing ranges, empty input, contradictions, fallbacks, and schemas).
* **Demonstration:** `node agents/demo-lab-agent.js` (interactive scenarios with clear inputs, outputs, and validation steps).

---

## 12. What the Lab Agent Does NOT Do (Scope Boundaries)
To maintain strict architectural separation:
* **Does NOT diagnose diseases:** Never outputs definitive diagnoses (e.g. "Patient has chronic lymphocytic leukemia"); flags patterns only (e.g. "Possible leukocytosis pattern; clinical correlation required").
* **Does NOT prescribe drugs or dosages:** Medication decisions belong to human physicians.
* **Does NOT query patient history:** Historical trend correlation belongs to Module B (Machine 2 Clinical Decision Support Agent).
* **Does NOT enforce blockchain commit policy:** Policy checks belong to Module C (Machine 3 Governance Agent).
* **Does NOT execute Fabric transactions or IPFS pins directly:** Storage and consensus belong to the gateway orchestration layer.

---

## 13. Future Integration Point
When the multi-agent orchestrator is connected:
```javascript
const labAgent = require('./agents/lab-agent');

// In orchestrator or server.js:
const labResult = await labAgent.execute({
  runId: 'RUN-9021',
  patientId: req.body.patientId,
  input: {
    resultData: parsedResultData,
    testCode: req.body.testCode,
    reportText: extractedReportText,
    reportTextSource: req.file ? req.file.originalname : undefined,
  },
});

// Forward labResult to:
// 1. IPFS (save triage CID)
// 2. Machine 2 (CDS Agent with longitudinal history)
// 3. Machine 3 (Governance Guardrails)
```
