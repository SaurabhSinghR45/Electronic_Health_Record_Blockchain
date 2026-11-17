'use strict';

/**
 * Unit Tests for Lab Report Analysis Agent
 * Author: Saurabh Singh
 * 
 * Verifies all 10 required test criteria:
 * 1. Normal report analysis
 * 2. Abnormal report (isolated finding)
 * 3. Multiple abnormalities detection
 * 4. Missing reference range handling
 * 5. Empty input validation
 * 6. Malformed input toleration
 * 7. Invalid Gemini response handling
 * 8. Deterministic validation catching contradictory interpretation
 * 9. Gemini / fallback heuristic behavior
 * 10. Standard AgentResult output structure compliance
 * 
 * Run with: node agents/lab-agent.test.js
 */

const assert = require('assert');
const {
  execute,
  normalizeLabInput,
  parseReferenceRange,
  parseNumericValue,
  validateLabFindings,
  extractHeuristicFindings,
} = require('./lab-agent');
const { mockReports } = require('./mock-data');

let passedTests = 0;
let failedTests = 0;

async function runTest(name, testFn) {
  try {
    await testFn();
    console.log(`  [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err.message}`);
    failedTests++;
  }
}

async function runAllTests() {
  console.log('\n\n');
  console.log('====================================================');
  console.log('RUNNING LAB REPORT ANALYSIS AGENT UNIT TESTS');
  console.log('====================================================\n');

  // Test 1: Normal report
  await runTest('1. Normal report produces in-range findings', async () => {
    const report = mockReports.test1_normalCBC;
    const result = await execute(report);

    assert.strictEqual(result.agentId, 'lab-agent');
    assert.ok(result.status === 'SUCCESS' || result.status === 'FALLBACK');
    assert.ok(result.result.findings.length >= 3, 'Should extract findings');

    const hbFinding = result.result.findings.find((f) => f.test.toLowerCase().includes('hemoglobin'));
    assert.ok(hbFinding, 'Hemoglobin finding must exist');
    assert.strictEqual(hbFinding.value, 14.5);
    assert.strictEqual(hbFinding.interpretation, 'normal');
    assert.ok(hbFinding.evidence, 'Evidence must be present');
  });

  // Test 2: Abnormal report (Low hemoglobin)
  await runTest('2. Abnormal report identifies out-of-range value and abnormality flag', async () => {
    const report = mockReports.test2_lowHemoglobin;
    const result = await execute(report);

    assert.strictEqual(result.agentId, 'lab-agent');
    const hbFinding = result.result.findings.find((f) => f.test.toLowerCase().includes('hemoglobin'));
    assert.ok(hbFinding, 'Hemoglobin finding must exist');
    assert.strictEqual(hbFinding.value, 9.2);
    assert.strictEqual(hbFinding.interpretation, 'below_reference');
    assert.ok(hbFinding.evidence.includes('9.2'), 'Evidence must cite verbatim value');
  });

  // Test 3: Multiple abnormalities
  await runTest('3. Multiple abnormalities (hyperglycemia & dyslipidemia) detected', async () => {
    const report = mockReports.test3_multipleAbnormalities;
    const result = await execute(report);

    assert.strictEqual(result.agentId, 'lab-agent');
    assert.ok(result.result.findings.length >= 4, 'Should extract multiple findings');

    const glucose = result.result.findings.find((f) => f.test.toLowerCase().includes('glucose'));
    const chol = result.result.findings.find((f) => f.test.toLowerCase().includes('cholesterol'));
    assert.ok(glucose, 'Glucose finding must exist');
    assert.ok(chol, 'Cholesterol finding must exist');
    assert.strictEqual(glucose.interpretation, 'above_reference');
    assert.strictEqual(chol.interpretation, 'above_reference');
  });

  // Test 4: Missing reference ranges
  await runTest('4. Missing reference ranges does not crash and marks inconclusive', async () => {
    const report = mockReports.test4_missingReferenceRanges;
    const result = await execute(report);

    assert.strictEqual(result.agentId, 'lab-agent');
    assert.ok(result.result.findings.length >= 2, 'Findings extracted despite missing ranges');
    const ferritin = result.result.findings.find((f) => f.test.toLowerCase().includes('ferritin'));
    assert.ok(ferritin, 'Ferritin must be parsed');
    assert.strictEqual(ferritin.interpretation, 'inconclusive');
  });

  // Test 5: Empty input
  await runTest('5. Empty input fails gracefully with ERROR status and low confidence', async () => {
    const report = mockReports.test6_emptyInvalidReport;
    const result = await execute(report);

    assert.strictEqual(result.agentId, 'lab-agent');
    assert.strictEqual(result.status, 'ERROR');
    assert.strictEqual(result.confidence, 'low');
    assert.ok(result.errors.length > 0, 'Must record error for empty input');
    assert.strictEqual(result.result.findings.length, 0);
  });

  // Test 6: Malformed input (null, undefined, primitives)
  await runTest('6. Malformed input tolerates non-object parameters gracefully', async () => {
    const nullResult = await execute(null);
    assert.strictEqual(nullResult.status, 'ERROR');

    const stringResult = await execute('not-an-object');
    assert.strictEqual(stringResult.status, 'ERROR');

    const flatInputResult = await execute({
      testCode: 'CBC',
      reportText: 'Hemoglobin: 12.5 g/dL (Reference: 12.0-16.0)',
    });
    assert.ok(flatInputResult.status === 'SUCCESS' || flatInputResult.status === 'FALLBACK');
    assert.strictEqual(flatInputResult.result.findings.length, 1);
  });

  // Test 7: Invalid Gemini response parsing
  await runTest('7. Invalid Gemini response falls back cleanly to heuristic analysis', async () => {
    // Simulate invalid model response by testing validateLabFindings with corrupted payload
    const corruptedPayload = {
      summary: null,
      abnormalities: 'not-an-array',
      riskFlags: 12345,
      confidence: 'SUPER_HIGH_INVALID',
      findings: 'corrupted',
    };
    const reportText = 'Hemoglobin: 9.0 g/dL (Reference: 13.5-17.5)';
    const validated = validateLabFindings(corruptedPayload, reportText, null);

    assert.strictEqual(validated.confidence, 'low', 'Confidence should default to low on invalid input');
    assert.ok(Array.isArray(validated.sanitizedResult.abnormalities), 'Abnormalities must be normalized to array');
    assert.ok(Array.isArray(validated.sanitizedResult.riskFlags), 'Risk flags must be normalized to array');
    assert.ok(Array.isArray(validated.sanitizedResult.findings), 'Findings must be derived via fallback');
    assert.strictEqual(validated.sanitizedResult.findings[0].value, 9.0);
  });

  // Test 8: Deterministic validation catching contradictory interpretation
  await runTest('8. Deterministic validation catches contradictory interpretation (Gemini says normal for low Hb)', async () => {
    // Model returns "normal" when Hb is 9.2 (Reference: 13.5-17.5)
    const contradictoryOutput = {
      summary: 'All values appear fine.',
      abnormalities: [],
      riskFlags: [],
      confidence: 'high',
      findings: [
        {
          test: 'Hemoglobin',
          value: 9.2,
          unit: 'g/dL',
          referenceRange: '13.5-17.5 g/dL',
          interpretation: 'normal', // CONTRADICTION!
          evidence: 'Hemoglobin: 9.2 g/dL (Reference: 13.5-17.5)',
        },
      ],
    };

    const reportText = 'Hemoglobin: 9.2 g/dL (Reference: 13.5-17.5)';
    const validated = validateLabFindings(contradictoryOutput, reportText, null);

    assert.ok(validated.errors.length > 0, 'Validator must catch contradiction error');
    assert.ok(validated.errors[0].includes('Contradiction detected'), 'Error must explain contradiction');
    assert.strictEqual(validated.sanitizedResult.findings[0].interpretation, 'below_reference', 'Must correct interpretation');
    assert.strictEqual(validated.confidence, 'medium', 'Must downgrade confidence from high upon contradiction');
  });

  // Test 9: Gemini / fallback behavior
  await runTest('9. Fallback heuristic operates accurately when offline', async () => {
    const report = mockReports.test7_fallbackScenario;
    const result = await execute(report);

    assert.strictEqual(result.agentId, 'lab-agent');
    assert.ok(result.status === 'FALLBACK' || result.status === 'SUCCESS');
    assert.ok(result.result.summary.length > 0, 'Summary generated');
    assert.ok(result.result.findings.length >= 2, 'Extracted findings in fallback mode');
    const glucose = result.result.findings.find((f) => f.test.toLowerCase().includes('glucose'));
    assert.ok(glucose);
    assert.strictEqual(glucose.interpretation, 'above_reference');
    assert.ok(glucose.evidence.includes('235'));
  });

  // Test 10: Standard AgentResult output structure
  await runTest('10. Output adheres strictly to Standard AgentResult specification', async () => {
    const report = mockReports.test1_normalCBC;
    const result = await execute(report);

    // Verify top-level structure
    assert.ok('agentId' in result, 'Must contain agentId');
    assert.ok('status' in result, 'Must contain status');
    assert.ok('result' in result, 'Must contain result');
    assert.ok('confidence' in result, 'Must contain confidence');
    assert.ok('errors' in result, 'Must contain errors');
    assert.ok('metadata' in result, 'Must contain metadata');

    // Verify result payload
    const payload = result.result;
    assert.ok('summary' in payload, 'result must contain summary');
    assert.ok('findings' in payload, 'result must contain findings');
    assert.ok('abnormalities' in payload, 'result must contain abnormalities');
    assert.ok('riskFlags' in payload, 'result must contain riskFlags');

    // Verify finding structure
    if (payload.findings.length > 0) {
      const f = payload.findings[0];
      assert.ok('test' in f, 'Finding must have test');
      assert.ok('value' in f, 'Finding must have value');
      assert.ok('unit' in f, 'Finding must have unit');
      assert.ok('referenceRange' in f, 'Finding must have referenceRange');
      assert.ok('interpretation' in f, 'Finding must have interpretation');
      assert.ok('evidence' in f, 'Finding must have evidence');
    }

    // Verify metadata
    assert.ok('runId' in result.metadata, 'metadata must have runId');
    assert.ok('patientId' in result.metadata, 'metadata must have patientId');
    assert.ok('disclaimer' in result.metadata, 'metadata must contain disclaimer');
  });

  console.log('\n====================================================');
  console.log(`TEST SUMMARY: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('====================================================');
  console.log('\n\n');

  if (failedTests > 0) {
    process.exitCode = 1;
  }
}

runAllTests();
