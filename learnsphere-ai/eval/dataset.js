/**
 * LearnSphere AI evaluation dataset.
 *
 * A small, fully synthetic, hand-labelled set. Every document here was written
 * for this project, so there is no licensing question and the expected answers
 * are unambiguous.
 *
 * Questions fall into three labelled categories:
 *
 *   SUPPORTED   - the answer is genuinely in the corpus, phrased the way a
 *                 student who read the notes would phrase it. The system must
 *                 retrieve the right document, cite the right page, and answer.
 *   UNSUPPORTED - nothing in the corpus answers this. The system must refuse.
 *                 A refusal is the correct result, not a failure.
 *   BORDERLINE  - heavily paraphrased or metaphorical questions where the notes
 *                 do contain the underlying idea but almost none of the wording
 *                 matches. Either an answer or a refusal is acceptable here.
 *                 These are reported for visibility and are NOT used to gate the
 *                 build, because the honest statement is "we do not know which
 *                 behaviour is better", not a made-up pass mark.
 *
 * The borderline set exists because the first evaluation run exposed exactly
 * this weakness: a question mentioning one common word from the notes was
 * answered confidently even though it was about a different subject.
 */

export const DOCUMENTS = [
  {
    name: 'biology-photosynthesis.txt',
    mimeType: 'text/plain',
    text: `Photosynthesis is the process by which green plants convert light energy into chemical energy stored in glucose.

The light-dependent reactions take place in the thylakoid membrane of the chloroplast and produce ATP and NADPH.

The Calvin cycle is the light-independent stage of photosynthesis and fixes carbon dioxide into glucose using ATP and NADPH.

Chlorophyll is the green pigment that absorbs light most strongly in the blue and red regions of the visible spectrum.

Cellular respiration releases energy from glucose and produces ATP, carbon dioxide and water inside the mitochondria.`,
  },
  {
    name: 'database-systems.txt',
    mimeType: 'text/plain',
    text: `A relational database is a collection of data organised as tables of rows and columns and related to one another by keys.

Normalisation is the process of organising tables and columns to minimise data redundancy and unwanted dependency.

An index is a data structure that speeds up the retrieval of rows at the cost of extra storage space and slower writes.

A transaction is a unit of work that is either committed in full or rolled back entirely so the database stays consistent.

A foreign key is a column that references the primary key of another table and enforces referential integrity between them.`,
  },
  {
    name: 'thermodynamics-notes.pdf',
    mimeType: 'application/pdf',
    // Rendered into a real two-page PDF at evaluation time.
    pdfPages: [
      `Thermodynamics is the branch of physics that studies heat, work, temperature and energy transfer.

The first law of thermodynamics states that energy cannot be created or destroyed in an isolated system.

The second law of thermodynamics states that the entropy of an isolated system always increases over time.

Entropy is a measure of the number of microscopic configurations that correspond to the macroscopic state of a system.`,
      `Enthalpy is the total heat content of a thermodynamic system at constant pressure.

A reversible process is an idealised process that can be reversed without changing the entropy of the universe.

Isobaric means a thermodynamic process that takes place at constant pressure.`,
    ],
  },
  {
    name: 'bangla-ml-notes.txt',
    mimeType: 'text/plain',
    text: `মেশিন লার্নিং হলো কম্পিউটারকে তথ্য থেকে শিখতে দেওয়ার পদ্ধতি, যেখানে স্পষ্ট নিয়ম না লিখে মডেল উদাহরণ থেকে ধারণা তৈরি করে।

তত্ত্বাবধানে শিক্ষণ হলো সেই পদ্ধতি যেখানে প্রতিটি উদাহরণের সঙ্গে সঠিক উত্তর লেবেল আকারে দেওয়া থাকে।

অতিরিক্ত ফিটিং হলো এমন অবস্থা যখন মডেল প্রশিক্ষণের তথ্য মুখস্থ করে ফেলে কিন্তু নতুন তথ্যে দুর্বল ফল দেয়।

শিখনের হার হলো গ্রেডিয়েন্ট ডিসেন্টে প্রতি ধাপে প্যারামিটার কতটা পরিবর্তিত হবে তা নিয়ন্ত্রণকারী সংখ্যা।`,
  },
];

/** Questions the corpus genuinely answers, in natural student wording. */
export const SUPPORTED = [
  {
    id: 'q01',
    question: 'What does the Calvin cycle fix?',
    expect: { document: 'biology-photosynthesis.txt', page: 1, mustMention: 'carbon dioxide' },
  },
  {
    id: 'q02',
    question: 'Which pigment absorbs light in the blue and red regions of the spectrum?',
    expect: { document: 'biology-photosynthesis.txt', page: 1, mustMention: 'chlorophyll' },
  },
  {
    id: 'q03',
    question: 'Where do the light-dependent reactions take place and what do they produce?',
    expect: { document: 'biology-photosynthesis.txt', page: 1, mustMention: 'thylakoid' },
  },
  {
    id: 'q04',
    question: 'What is normalisation and what does it reduce?',
    expect: { document: 'database-systems.txt', page: 1, mustMention: 'redundancy' },
  },
  {
    id: 'q05',
    question: 'What does an index cost in exchange for faster retrieval?',
    expect: { document: 'database-systems.txt', page: 1, mustMention: 'storage' },
  },
  {
    id: 'q06',
    question: 'What is a transaction in a database?',
    expect: { document: 'database-systems.txt', page: 1, mustMention: 'committed' },
  },
  {
    id: 'q07',
    question: 'What is a foreign key for?',
    expect: { document: 'database-systems.txt', page: 1, mustMention: 'primary key' },
  },
  {
    id: 'q08',
    question: 'State the second law of thermodynamics.',
    expect: { document: 'thermodynamics-notes.pdf', page: 1, mustMention: 'entropy' },
  },
  {
    id: 'q09',
    question: 'What is entropy a measure of?',
    expect: { document: 'thermodynamics-notes.pdf', page: 1, mustMention: 'configurations' },
  },
  {
    id: 'q10',
    question: 'What is enthalpy in a thermodynamic system?',
    expect: { document: 'thermodynamics-notes.pdf', page: 2, mustMention: 'heat content' },
  },
  {
    id: 'q11',
    question: 'What does isobaric mean?',
    expect: { document: 'thermodynamics-notes.pdf', page: 2, mustMention: 'constant pressure' },
  },
  {
    id: 'q12',
    question: 'অতিরিক্ত ফিটিং কী এবং কেন এটি খারাপ?',
    expect: { document: 'bangla-ml-notes.txt', page: 1, mustMention: 'মুখস্থ' },
  },
  {
    id: 'q13',
    question: 'শিখনের হার কী নিয়ন্ত্রণ করে?',
    expect: { document: 'bangla-ml-notes.txt', page: 1, mustMention: 'গ্রেডিয়েন্ট' },
  },
];

/** Nothing in the corpus answers these. Refusing is the correct result. */
export const UNSUPPORTED = [
  { id: 'u01', question: 'Who won the 2022 world cup final?', expect: null },
  { id: 'u02', question: 'What is the capital of Mongolia?', expect: null },
  { id: 'u03', question: 'How do I configure a Postgres connection pool in pgbouncer transaction mode?', expect: null },
  { id: 'u04', question: 'Explain the Krebs cycle and its role in oxidative phosphorylation.', expect: null },
  { id: 'u05', question: 'Write me a recipe for a chocolate cake with buttercream icing.', expect: null },
  { id: 'u06', question: 'Summarise the plot of the film Inception.', expect: null },
];

/**
 * Paraphrases where either behaviour is defensible. Reported, not gated.
 * Each carries a `note` describing the underlying idea in the material.
 */
export const BORDERLINE = [
  {
    id: 'b01',
    question: 'How does a plant capture sunlight and turn it into food?',
    expect: { document: 'biology-photosynthesis.txt', page: 1, mustMention: 'glucose' },
    note: 'The material covers photosynthesis, but "capture sunlight" and "food" are paraphrases of "convert light energy" and "glucose".',
  },
  {
    id: 'b02',
    question: 'What happens to a transaction that cannot be completed?',
    expect: { document: 'database-systems.txt', page: 1, mustMention: 'rolled back' },
    note: 'The material covers rollback, but "cannot be completed" never appears; only "transaction" is recognised.',
  },
  {
    id: 'b03',
    question: 'Why does a messy room never tidy itself up?',
    expect: { document: 'thermodynamics-notes.pdf', page: 1, mustMention: 'entropy' },
    note: 'A metaphor for the second law. Almost none of the wording appears in the material.',
  },
];

export const QUESTIONS = [...SUPPORTED, ...UNSUPPORTED, ...BORDERLINE];

export const ALL_ROWS = [
  ...SUPPORTED.map((q) => ({ ...q, category: 'supported' })),
  ...UNSUPPORTED.map((q) => ({ ...q, category: 'unsupported' })),
  ...BORDERLINE.map((q) => ({ ...q, category: 'borderline' })),
];

export default { DOCUMENTS, SUPPORTED, UNSUPPORTED, BORDERLINE, QUESTIONS, ALL_ROWS };
