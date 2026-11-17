'use strict';

/**
 * Mock Lab Reports for Independent Development & Testing
 * Designed for Lab Report Analysis Agent (Saurabh Singh)
 * 
 * Provides 7 distinct realistic scenarios:
 * 1. Normal CBC (all values in range)
 * 2. Low Hemoglobin (isolated single abnormality)
 * 3. Multiple Abnormalities (glycemic and lipid flags)
 * 4. Missing Reference Ranges (tests with no explicit bounds)
 * 5. OCR-Corrupted Report (noisy formatting, typos, artifacts)
 * 6. Empty / Invalid Input (nulls, whitespace, malformed)
 * 7. Gemini Unavailable / Fallback (offline testing)
 */

const mockReports = {
  test1_normalCBC: {
    runId: 'RUN-TEST-001',
    patientId: 'patient-1001',
    requestingAgent: 'TEST_HARNESS',
    metadata: { testCase: 'Normal CBC' },
    input: {
      testCode: 'CBC',
      resultData: {
        hemoglobin: '14.5 g/dL',
        rbc: '4.8 million/uL',
        wbc: '6,800 /uL',
        platelets: '250,000 /uL',
      },
      reportText: [
        'COMPLETE BLOOD COUNT (CBC)',
        'Patient ID: patient-1001',
        'Hemoglobin: 14.5 g/dL (Reference: 13.5-17.5)',
        'RBC Count: 4.8 million/uL (Reference: 4.5-5.9)',
        'WBC Count: 6,800 /uL (Reference: 4,500-11,000)',
        'Platelets: 250,000 /uL (Reference: 150,000-450,000)',
        'Impression: Normal hematological profile.',
      ].join('\n'),
      reportTextSource: 'cbc_normal_patient1001.pdf',
    },
  },

  test2_lowHemoglobin: {
    runId: 'RUN-TEST-002',
    patientId: 'patient-1002',
    requestingAgent: 'TEST_HARNESS',
    metadata: { testCase: 'Low Hemoglobin' },
    input: {
      testCode: 'CBC',
      resultData: {
        hemoglobin: '9.2 g/dL',
        rbc: '3.1 million/uL',
        wbc: '6,500 /uL',
        platelets: '220,000 /uL',
      },
      reportText: [
        'COMPLETE BLOOD COUNT (CBC)',
        'Patient ID: patient-1002',
        'Hemoglobin: 9.2 g/dL (Reference: 13.5-17.5)',
        'RBC Count: 3.1 million/uL (Reference: 4.5-5.9)',
        'WBC Count: 6,500 /uL (Reference: 4,500-11,000)',
        'Platelets: 220,000 /uL (Reference: 150,000-450,000)',
        'Impression: Microcytic hypochromic red cell picture.',
      ].join('\n'),
      reportTextSource: 'cbc_low_hb_patient1002.pdf',
    },
  },

  test3_multipleAbnormalities: {
    runId: 'RUN-TEST-003',
    patientId: 'patient-1003',
    requestingAgent: 'TEST_HARNESS',
    metadata: { testCase: 'Multiple Abnormalities' },
    input: {
      testCode: 'METABOLIC_LIPID',
      resultData: {
        glucose_fasting: '198 mg/dL',
        hba1c: '9.4 %',
        total_cholesterol: '265 mg/dL',
        triglycerides: '280 mg/dL',
        ldl_cholesterol: '172 mg/dL',
        hdl_cholesterol: '37 mg/dL',
      },
      reportText: [
        'METABOLIC & LIPID PANEL',
        'Patient ID: patient-1003',
        'Fasting Blood Glucose: 198 mg/dL (Reference: 70-99)',
        'HbA1c: 9.4 % (Reference: 4.0-5.6)',
        'Total Cholesterol: 265 mg/dL (Reference: < 200)',
        'Triglycerides: 280 mg/dL (Reference: < 150)',
        'LDL Cholesterol: 172 mg/dL (Reference: < 100)',
        'HDL Cholesterol: 37 mg/dL (Reference: > 40)',
        'Impression: Combined marked hyperglycemia and mixed dyslipidemia.',
      ].join('\n'),
      reportTextSource: 'metabolic_lipid_abnormal_patient1003.pdf',
    },
  },

  test4_missingReferenceRanges: {
    runId: 'RUN-TEST-004',
    patientId: 'patient-1004',
    requestingAgent: 'TEST_HARNESS',
    metadata: { testCase: 'Missing Reference Ranges' },
    input: {
      testCode: 'IRON_PANEL',
      resultData: {
        hemoglobin: '10.1 g/dL',
        ferritin: '8 ng/mL',
        serum_iron: '32 mcg/dL',
      },
      reportText: [
        'IRON STATUS REPORT',
        'Patient ID: patient-1004',
        'Hemoglobin: 10.1 g/dL',
        'Ferritin: 8 ng/mL',
        'Serum Iron: 32 mcg/dL',
        'Note: Reference ranges unavailable from regional referral laboratory.',
      ].join('\n'),
      reportTextSource: 'iron_panel_no_ref_patient1004.pdf',
    },
  },

  test5_ocrCorruptedReport: {
    runId: 'RUN-TEST-005',
    patientId: 'patient-1005',
    requestingAgent: 'TEST_HARNESS',
    metadata: { testCase: 'OCR Corrupted Report' },
    input: {
      testCode: 'CBC_OCR',
      resultData: {
        rawOcrStatus: 'low_confidence_scan',
      },
      reportText: [
        '*** C0MPL3TE BL00D C0UNT (CBC) - SCAN RECOG ***',
        'P@tient: patient-1005   D@te: 2026-09-15',
        'Hgb: 8.8 g/dL (R@f: 12.0 - 15.5)',
        'W-B-C: 13,200 /uL [Ref: 4,000 - 11,000]',
        'PLT : 95,000 /uL (150,000 - 450,000)',
        '!MPRESS!ON: cytopenias noted in periph smear. artifact noise present.',
      ].join('\n'),
      reportTextSource: 'scan_ocr_noisy_patient1005.jpg',
    },
  },

  test6_emptyInvalidReport: {
    runId: 'RUN-TEST-006',
    patientId: 'patient-1006',
    requestingAgent: 'TEST_HARNESS',
    metadata: { testCase: 'Empty / Invalid Report' },
    input: {
      testCode: '',
      resultData: null,
      reportText: '   \n  \t  \n  ',
      reportTextSource: '',
    },
  },

  test7_fallbackScenario: {
    runId: 'RUN-TEST-007',
    patientId: 'patient-1007',
    requestingAgent: 'TEST_HARNESS',
    metadata: { testCase: 'Gemini Offline / Fallback Heuristic' },
    input: {
      testCode: 'CBC_GLUCOSE',
      resultData: {
        hemoglobin: '8.4 g/dL',
        glucose: '235 mg/dL',
      },
      reportText: [
        'LABORATORY REPORT',
        'Patient ID: patient-1007',
        'Hemoglobin: 8.4 g/dL (Reference: 12.0-16.0)',
        'Fasting Blood Glucose: 235 mg/dL (Reference: 70-99)',
        'Impression: Low hemoglobin and elevated glucose.',
      ].join('\n'),
      reportTextSource: 'fallback_patient1007.pdf',
    },
  },
};

module.exports = {
  mockReports,
};
