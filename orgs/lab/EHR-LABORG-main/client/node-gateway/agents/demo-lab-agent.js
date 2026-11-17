'use strict';

/**
 * Interactive Demonstration Script for Lab Report Analysis Agent
 * Author: Saurabh Singh
 * Module: Module A (Lab Report Ingestion & Abnormality Triage)
 * 
 * Standalone demonstration script runnable without Fabric, IPFS, or Docker:
 * Usage: node agents/demo-lab-agent.js
 */

const { execute, validateLabFindings } = require('./lab-agent');
const { mockReports } = require('./mock-data');

function printSeparator(char = '=', length = 60) {
  console.log(char.repeat(length));
}

async function runDemoScenario(title, payload) {
  printSeparator();
  console.log('LAB REPORT ANALYSIS AGENT');
  printSeparator();
  console.log(`SCENARIO: ${title}\n`);

  console.log('INPUT:');
  console.log(`  Run ID:           ${payload.runId || 'N/A'}`);
  console.log(`  Patient ID:       ${payload.patientId || (payload.input && payload.input.patientId) || 'N/A'}`);
  console.log(`  Test Code:        ${(payload.input && payload.input.testCode) || payload.testCode || 'N/A'}`);
  console.log(`  Source:           ${(payload.input && payload.input.reportTextSource) || payload.reportTextSource || 'N/A'}`);

  const reportText = (payload.input && payload.input.reportText) || payload.reportText || '';
  if (reportText) {
    console.log('  Report Narrative Excerpt:');
    reportText.split('\n').slice(0, 5).forEach((line) => console.log(`    | ${line}`));
    if (reportText.split('\n').length > 5) {
      console.log('    | ...');
    }
  }

  const result = await execute(payload);

  console.log('\nOUTPUT:');
  console.log(`  Agent ID:         ${result.agentId}`);
  console.log(`  Status:           ${result.status}`);
  console.log(`  Confidence:       ${result.confidence}`);
  console.log(`  Execution Mode:   ${result.metadata.executionMode} (Model: ${result.result.modelUsed})`);
  console.log(`  Summary:          ${result.result.summary}`);

  console.log('\nStructured Findings (Novelty 1: Evidence Grounding):');
  if (result.result.findings && result.result.findings.length > 0) {
    result.result.findings.forEach((f, idx) => {
      console.log(`   ${idx + 1}. [${f.test}] = ${f.value} ${f.unit}`);
      console.log(`      Reference Range: ${f.referenceRange}`);
      console.log(`      Interpretation:  ${f.interpretation}`);
      console.log(`      Grounding:       "${f.evidence}"`);
    });
  } else {
    console.log('   (No findings extracted)');
  }

  console.log('\nAbnormalities:');
  if (result.result.abnormalities && result.result.abnormalities.length > 0) {
    result.result.abnormalities.forEach((ab) => console.log(`   - ${ab}`));
  } else {
    console.log('   None detected (Normal range profile).');
  }

  console.log('\nRisk Flags:');
  if (result.result.riskFlags && result.result.riskFlags.length > 0) {
    result.result.riskFlags.forEach((rf) => console.log(`   * ${rf}`));
  } else {
    console.log('   No clinical risk flags triggered.');
  }

  if (result.errors && result.errors.length > 0) {
    console.log('\nValidation Errors / Corrections:');
    result.errors.forEach((err) => console.log(`   ! ${err}`));
  }

  console.log(`\nDisclaimer: ${result.metadata.disclaimer}`);
  printSeparator('-', 60);
  console.log('\n');
}

async function runContradictionDemo() {
  printSeparator();
  console.log('DEMONSTRATION: NOVELTY 2 - DETERMINISTIC CONTRADICTION VALIDATOR');
  printSeparator();
  console.log('Simulating an LLM hallucination where Hemoglobin is 9.2 g/dL (Ref: 13.5-17.5)');
  console.log('but the LLM mistakenly labels the interpretation as "normal".\n');

  const simulatedLlmOutput = {
    summary: 'Mild routine checkup summary.',
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
  const validation = validateLabFindings(simulatedLlmOutput, reportText, null);

  console.log('Raw Model Interpretation:  ', simulatedLlmOutput.findings[0].interpretation);
  console.log('Raw Model Confidence:      ', simulatedLlmOutput.confidence);
  console.log('Deterministic Corrections: ');
  validation.errors.forEach((e) => console.log(`   -> ${e}`));
  console.log('Validated Interpretation:  ', validation.sanitizedResult.findings[0].interpretation);
  console.log('Adjusted Confidence:       ', validation.confidence);
  printSeparator('-', 60);
  console.log('\n');
}

async function main() {
  console.log('\n====================================================');
  console.log('  LAB REPORT ANALYSIS AGENT - STANDALONE DEMO');
  console.log('  Student: Saurabh Singh');
  console.log('  Scope: Module A (Lab Report Ingestion & Abnormality Triage)');
  console.log('====================================================\n');

  // Scenario 1: Normal CBC
  await runDemoScenario('1. Normal Hematology (CBC)', mockReports.test1_normalCBC);

  // Scenario 2: Isolated Abnormality (Low Hemoglobin)
  await runDemoScenario('2. Isolated Abnormality (Low Hemoglobin / Anemia Alert)', mockReports.test2_lowHemoglobin);

  // Scenario 3: Multiple Abnormalities (Metabolic & Lipid)
  await runDemoScenario('3. Multiple Abnormalities (Severe Hyperglycemia & Dyslipidemia)', mockReports.test3_multipleAbnormalities);

  // Scenario 4: OCR Noise Handling
  await runDemoScenario('4. OCR-Corrupted Lab Report (Noise Tolerant Parsing)', mockReports.test5_ocrCorruptedReport);

  // Scenario 5: Deterministic Contradiction Validation (Novelty 2)
  await runContradictionDemo();

  // Scenario 6: Empty/Invalid Input
  await runDemoScenario('5. Empty / Invalid Input (Graceful Failure Guardrail)', mockReports.test6_emptyInvalidReport);

  console.log('====================================================');
  console.log('  DEMO COMPLETE: All scenarios processed cleanly');
  console.log('  Zero Fabric, Docker, or IPFS dependencies required.');
  console.log('====================================================\n');
}

main().catch((err) => {
  console.error('Demo encountered an unhandled error:', err);
});
