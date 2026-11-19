/**
 * Bilingual UI strings (English + Bangla).
 *
 * Only interface copy lives here. Study content, citations and extracted
 * passages are never translated: they stay in the language of the document.
 * Missing keys fall back to English so a gap degrades to readable text instead
 * of a raw key.
 */
const STORAGE_KEY = 'learnsphere.language';

const en = {
  'common.language': 'Language',
  'common.theme': 'Theme',
  'common.light': 'Light',
  'common.dark': 'Dark',
  'common.system': 'System',
  'common.loading': 'Loading…',
  'common.retry': 'Try again',
  'common.save': 'Save changes',
  'common.saving': 'Saving…',
  'common.cancel': 'Cancel',
  'common.signOut': 'Sign out',
  'common.back': 'Back',
  'common.close': 'Close',

  'nav.overview': 'Overview',
  'nav.materials': 'My Materials',
  'nav.summary': 'Study summary',
  'nav.studio': 'Visual studio',
  'nav.path': 'Learning path',
  'nav.chat': 'AI Teacher',
  'nav.practice': 'Practice',
  'nav.flashcards': 'Flashcards',
  'nav.review': 'Due for review',
  'nav.progress': 'Progress',
  'nav.coach': 'Exam coach',
  'nav.plan': 'Study plan',
  'nav.dna': 'Learning DNA',
  'nav.settings': 'Settings',

  'shell.skip': 'Skip to content',
  'shell.brandSub': 'Source-grounded tutor',
  'shell.sync': 'Sync',
  'shell.signedIn': 'Signed in',
  'shell.studyProfile': 'Study profile',
  'shell.changeProfile': 'Change study profile',
  'shell.accountSettings': 'Account settings',
  'shell.openNav': 'Open navigation',
  'shell.closeNav': 'Close navigation',
  'shell.footer': 'International AI Builders Congress 2026 · Challenge: AI Teacher · Team NITER_Parallax',
  'shell.footerNote': 'Answers are citation-verified against your own uploads. LearnSphere AI never measures mastery.',

  'welcome.eyebrow': 'International AI Builders Congress 2026',
  'welcome.title': 'Study from your own material, with a tutor that cites its sources.',
  'welcome.lead':
    'LearnSphere AI turns your PDFs, notes and slides into cited answers, grounded quizzes, flashcards and a study plan — in English or Bangla. Your uploads stay in your own account.',
  'welcome.ctaLogin': 'Log in',
  'welcome.ctaSignup': 'Create account',
  'welcome.ctaExplore': 'Explore LearnSphere',
  'auth.inviteOnlyTitle': 'Invitation only',
  'auth.inviteOnlyBody':
    'LearnSphere AI is invitation-only: the five team email addresses on the access list can create an account. Ask the team if your address is missing.',
  'welcome.f1t': 'Answered from your documents',
  'welcome.f1b': 'Every claim carries the page it came from. When the material does not cover a question, the tutor says so instead of inventing an answer.',
  'welcome.f2t': 'Practice that shows its evidence',
  'welcome.f2b': 'Quizzes, flashcards and recall checks are generated from your uploads. Scores are practice feedback, never a predicted grade.',
  'welcome.f3t': 'A plan you control',
  'welcome.f3b': 'Map your syllabus to your own files and get a daily schedule you can edit, pause and complete.',
  'welcome.f4t': 'Private by default',
  'welcome.f4b': 'Accounts are protected by server-verified sessions. You can export or delete everything you have uploaded at any time.',
  'welcome.privacy': 'No password, session token or API key is stored in this browser.',
  'welcome.how': 'How it works',
  'welcome.step1': 'Upload material',
  'welcome.step1b': 'PDF, Word, Markdown, text or pasted notes.',
  'welcome.step2': 'Ask, practise, review',
  'welcome.step2b': 'Cited answers, quizzes, flashcards, teach-back.',
  'welcome.step3': 'Follow your plan',
  'welcome.step3b': 'A schedule built only from what your files cover.',

  'auth.loginTitle': 'Welcome back',
  'auth.loginLead': 'Sign in to reach your library, practice history and study plan.',
  'auth.signupTitle': 'Create your account',
  'auth.signupLead': 'One account keeps your material and progress private to you.',
  'auth.email': 'Email',
  'auth.emailHint': 'Used only to sign in. It is not sent to an AI provider.',
  'auth.password': 'Password',
  'auth.passwordHint': 'At least {min} characters. Stored only as a salted scrypt hash.',
  'auth.displayName': 'Display name',
  'auth.displayNameHint': 'Optional. Shown in the sidebar instead of your email.',
  'auth.showPassword': 'Show password',
  'auth.hidePassword': 'Hide password',
  'auth.signIn': 'Sign in',
  'auth.createAccount': 'Create my account',
  'auth.working': 'Please wait…',
  'auth.noAccount': 'New to LearnSphere AI?',
  'auth.haveAccount': 'Already have an account?',
  'auth.forgot': 'Forgot your password?',
  'auth.emailInvalid': 'Enter a valid email address.',
  'auth.passwordShort': 'Use at least {min} characters.',
  'auth.passwordRequired': 'Enter your password.',
  'auth.genericError': 'Could not continue. Please try again.',
  'auth.signedInAs': 'Signed in as {email}.',
  'auth.created': 'Account created. Welcome to LearnSphere AI.',
  'auth.loginFailed': 'Sign-in failed',
  'auth.signupFailed': 'Account could not be created',
  'auth.sessionNote': 'Your session lives in a secure, HttpOnly cookie. The browser never stores your password.',

  'reset.title': 'Reset your password',
  'reset.lead': 'Enter the email on your account. The answer is the same whether or not an account exists.',
  'reset.request': 'Send reset token',
  'reset.requesting': 'Creating token…',
  'reset.sent': 'If that email has an account, a one-time token has been created. It expires in 30 minutes.',
  'reset.devTitle': 'Development token',
  'reset.devBody':
    'No email provider is configured on this build, so the server returns the token here. In production this is not shown and reset email delivery must be configured.',
  'reset.token': 'Reset token',
  'reset.newPassword': 'New password',
  'reset.confirm': 'Set new password',
  'reset.confirming': 'Updating…',
  'reset.done': 'Password updated. Sign in with your new password.',
  'reset.invalid': 'That token is not valid or has expired. Request a new one.',
  'reset.backToLogin': 'Back to sign in',
  'reset.needToken': 'Paste the reset token from your email.',
  'reset.emailConfigured': 'A reset email will be sent if the address has an account.',
  'reset.notConfigured':
    'No email delivery is configured on this deployment. Ask the project owner, or use the token shown below in development.',

  'onboard.title': 'Set up your study profile',
  'onboard.lead': 'A few details make the plan and practice suggestions useful. Everything here can be changed later in Settings.',
  'onboard.language': 'Interface language',
  'onboard.level': 'Study level',
  'onboard.levelSchool': 'School',
  'onboard.levelCollege': 'College',
  'onboard.levelUndergrad': 'Undergraduate',
  'onboard.levelPostgrad': 'Postgraduate',
  'onboard.levelSelf': 'Self-taught',
  'onboard.levelOther': 'Other',
  'onboard.levelNone': 'Prefer not to say',
  'onboard.subjects': 'Subjects',
  'onboard.subjectsHint': 'Comma separated, for example: Databases, Algorithms, Statistics.',
  'onboard.examDate': 'Exam date',
  'onboard.examDateHint': 'Optional. Used for the study plan countdown.',
  'onboard.minutes': 'Minutes per day',
  'onboard.days': 'Days per week',
  'onboard.finish': 'Save and open my dashboard',
  'onboard.skip': 'Skip for now',
  'onboard.saving': 'Saving your profile…',
  'onboard.invalidDate': 'Use a date in YYYY-MM-DD form.',
  'onboard.step': 'Step {n} of 2',
  'onboard.next': 'Continue',
  'onboard.back': 'Back',
  'onboard.summaryTitle': 'Ready to study',
  'onboard.summaryLead': 'You can change all of this in Settings. Upload material to get cited answers and practice.',
  'onboard.optional': 'Optional',

  'settings.appearance': 'Appearance and language',
  'settings.appearanceHint': 'Saved in this browser and, when signed in, on your account.',
  'settings.profile': 'Study profile details',
  'settings.export': 'Export my data',
  'settings.exportHint': 'Download your material list, passages, quizzes, flashcards, progress and plans as JSON.',
  'settings.exportButton': 'Download JSON',
  'settings.deleteTitle': 'Delete my account and data',
  'settings.deleteHint':
    'This removes every material, extracted passage, chat, quiz, attempt, flashcard, visual, learning path and plan, then deletes the account. It cannot be undone.',
  'settings.deleteButton': 'Delete account',
  'settings.deleteConfirm': 'Type DELETE to confirm',
  'settings.deletePassword': 'Confirm with your password',
  'settings.deleted': 'Your data has been deleted.',

  'people.you': 'you',
};

const bn = {
  'common.language': 'ভাষা',
  'common.theme': 'থিম',
  'common.light': 'হালকা',
  'common.dark': 'গাঢ়',
  'common.system': 'সিস্টেম',
  'common.loading': 'লোড হচ্ছে…',
  'common.retry': 'আবার চেষ্টা করুন',
  'common.save': 'পরিবর্তন সংরক্ষণ',
  'common.saving': 'সংরক্ষণ হচ্ছে…',
  'common.cancel': 'বাতিল',
  'common.signOut': 'সাইন আউট',
  'common.back': 'পিছনে',
  'common.close': 'বন্ধ',

  'nav.overview': 'সারসংক্ষেপ',
  'nav.materials': 'আমার উপকরণ',
  'nav.summary': 'পড়ার সারসংক্ষেপ',
  'nav.studio': 'ভিজ্যুয়াল স্টুডিও',
  'nav.path': 'শেখার পথ',
  'nav.chat': 'এআই শিক্ষক',
  'nav.practice': 'অনুশীলন',
  'nav.flashcards': 'ফ্ল্যাশকার্ড',
  'nav.review': 'পুনরালোচনার জন্য',
  'nav.progress': 'অগ্রগতি',
  'nav.coach': 'পরীক্ষা কোচ',
  'nav.plan': 'পড়ার পরিকল্পনা',
  'nav.dna': 'লার্নিং ডিএনএ',
  'nav.settings': 'সেটিংস',

  'shell.skip': 'মূল অংশে যান',
  'shell.brandSub': 'উৎসভিত্তিক শিক্ষক',
  'shell.sync': 'সিঙ্ক',
  'shell.signedIn': 'সাইন ইন করা',
  'shell.studyProfile': 'পড়ার প্রোফাইল',
  'shell.changeProfile': 'পড়ার প্রোফাইল বদলান',
  'shell.accountSettings': 'অ্যাকাউন্ট সেটিংস',
  'shell.openNav': 'নেভিগেশন খুলুন',
  'shell.closeNav': 'নেভিগেশন বন্ধ করুন',
  'shell.footer': 'International AI Builders Congress 2026 · Challenge: AI Teacher · Team NITER_Parallax',
  'shell.footerNote': 'উত্তরগুলো আপনার নিজের আপলোডের সাথে যাচাই করা। LearnSphere AI কখনো দক্ষতা মাপে না।',

  'welcome.eyebrow': 'International AI Builders Congress 2026',
  'welcome.title': 'নিজের উপকরণ থেকে পড়ুন, এমন শিক্ষকের সাথে যে উৎস দেখায়।',
  'welcome.lead':
    'LearnSphere AI আপনার পিডিএফ, নোট আর স্লাইড থেকে উৎসসহ উত্তর, প্রাসঙ্গিক কুইজ, ফ্ল্যাশকার্ড ও পড়ার পরিকল্পনা তৈরি করে — বাংলা বা ইংরেজিতে। আপনার আপলোড আপনার নিজের অ্যাকাউন্টেই থাকে।',
  'welcome.ctaLogin': 'লগ ইন',
  'welcome.ctaSignup': 'অ্যাকাউন্ট খুলুন',
  'welcome.ctaExplore': 'LearnSphere শুরু করুন',
  'auth.inviteOnlyTitle': 'শুধুমাত্র আমন্ত্রিতদের জন্য',
  'auth.inviteOnlyBody':
    'LearnSphere AI শুধুমাত্র আমন্ত্রিতদের জন্য: অ্যাক্সেস তালিকার পাঁচটি টিম ইমেইল দিয়েই অ্যাকাউন্ট তৈরি করা যাবে। আপনার ঠিকানা না থাকলে টিমকে জানান।',
  'welcome.f1t': 'আপনার নথি থেকেই উত্তর',
  'welcome.f1b': 'প্রতিটি দাবির সাথে তার পৃষ্ঠা দেখানো হয়। উপকরণে উত্তর না থাকলে শিক্ষক বানিয়ে না বলে জানিয়ে দেন।',
  'welcome.f2t': 'প্রমাণসহ অনুশীলন',
  'welcome.f2b': 'কুইজ, ফ্ল্যাশকার্ড ও স্মরণ-পরীক্ষা আপনার আপলোড থেকেই তৈরি। ফলাফল অনুশীলনের প্রতিক্রিয়া, কখনো অনুমিত গ্রেড নয়।',
  'welcome.f3t': 'আপনার নিয়ন্ত্রণে পরিকল্পনা',
  'welcome.f3b': 'সিলেবাসকে নিজের ফাইলের সাথে মিলিয়ে প্রতিদিনের সূচি নিন — সম্পাদনা, বিরতি ও সম্পন্ন করা যায়।',
  'welcome.f4t': 'ডিফল্টভাবেই ব্যক্তিগত',
  'welcome.f4b': 'অ্যাকাউন্ট সার্ভার-যাচাইকৃত সেশন দিয়ে সুরক্ষিত। যেকোনো সময় সব ডেটা এক্সপোর্ট বা মুছে ফেলতে পারেন।',
  'welcome.privacy': 'এই ব্রাউজারে কোনো পাসওয়ার্ড, সেশন টোকেন বা এপিআই কী রাখা হয় না।',
  'welcome.how': 'যেভাবে কাজ করে',
  'welcome.step1': 'উপকরণ আপলোড',
  'welcome.step1b': 'পিডিএফ, ওয়ার্ড, মার্কডাউন, টেক্সট বা নোট।',
  'welcome.step2': 'জিজ্ঞাসা, অনুশীলন, পুনরালোচনা',
  'welcome.step2b': 'উৎসসহ উত্তর, কুইজ, ফ্ল্যাশকার্ড, টিচ-ব্যাক।',
  'welcome.step3': 'পরিকল্পনা অনুসরণ',
  'welcome.step3b': 'শুধু আপনার ফাইল যা কভার করে তার ভিত্তিতে সূচি।',

  'auth.loginTitle': 'আবার স্বাগতম',
  'auth.loginLead': 'আপনার লাইব্রেরি, অনুশীলনের ইতিহাস ও পড়ার পরিকল্পনায় যেতে সাইন ইন করুন।',
  'auth.signupTitle': 'আপনার অ্যাকাউন্ট খুলুন',
  'auth.signupLead': 'একটি অ্যাকাউন্ট আপনার উপকরণ ও অগ্রগতি শুধু আপনার জন্য রাখে।',
  'auth.email': 'ইমেইল',
  'auth.emailHint': 'শুধু সাইন ইন করতে ব্যবহৃত। এআই প্রোভাইডারের কাছে যায় না।',
  'auth.password': 'পাসওয়ার্ড',
  'auth.passwordHint': 'কমপক্ষে {min} অক্ষর। শুধু সল্টেড scrypt হ্যাশ হিসেবে সংরক্ষিত।',
  'auth.displayName': 'প্রদর্শিত নাম',
  'auth.displayNameHint': 'ঐচ্ছিক। সাইডবারে ইমেইলের বদলে দেখানো হয়।',
  'auth.showPassword': 'পাসওয়ার্ড দেখুন',
  'auth.hidePassword': 'পাসওয়ার্ড লুকান',
  'auth.signIn': 'সাইন ইন',
  'auth.createAccount': 'আমার অ্যাকাউন্ট খুলুন',
  'auth.working': 'অনুগ্রহ করে অপেক্ষা করুন…',
  'auth.noAccount': 'LearnSphere AI-তে নতুন?',
  'auth.haveAccount': 'আগে থেকেই অ্যাকাউন্ট আছে?',
  'auth.forgot': 'পাসওয়ার্ড ভুলে গেছেন?',
  'auth.emailInvalid': 'সঠিক ইমেইল দিন।',
  'auth.passwordShort': 'কমপক্ষে {min} অক্ষর ব্যবহার করুন।',
  'auth.passwordRequired': 'পাসওয়ার্ড দিন।',
  'auth.genericError': 'এগোনো যায়নি। আবার চেষ্টা করুন।',
  'auth.signedInAs': '{email} হিসেবে সাইন ইন হয়েছে।',
  'auth.created': 'অ্যাকাউন্ট তৈরি হয়েছে। LearnSphere AI-তে স্বাগতম।',
  'auth.loginFailed': 'সাইন ইন ব্যর্থ',
  'auth.signupFailed': 'অ্যাকাউন্ট তৈরি করা যায়নি',
  'auth.sessionNote': 'আপনার সেশন নিরাপদ HttpOnly কুকিতে থাকে। ব্রাউজার আপনার পাসওয়ার্ড সংরক্ষণ করে না।',

  'reset.title': 'পাসওয়ার্ড রিসেট',
  'reset.lead': 'অ্যাকাউন্টের ইমেইল দিন। অ্যাকাউন্ট থাকুক বা না থাকুক উত্তর একই থাকবে।',
  'reset.request': 'রিসেট টোকেন তৈরি করুন',
  'reset.requesting': 'টোকেন তৈরি হচ্ছে…',
  'reset.sent': 'ঐ ইমেইলে অ্যাকাউন্ট থাকলে একবার ব্যবহারযোগ্য টোকেন তৈরি হয়েছে। এটি ৩০ মিনিটে শেষ হয়।',
  'reset.devTitle': 'ডেভেলপমেন্ট টোকেন',
  'reset.devBody':
    'এই বিল্ডে ইমেইল সেবা নেই, তাই সার্ভার টোকেনটি এখানে দেখায়। প্রোডাকশনে এটি দেখানো হয় না; সেখানে ইমেইল ডেলিভারি কনফিগার করতে হবে।',
  'reset.token': 'রিসেট টোকেন',
  'reset.newPassword': 'নতুন পাসওয়ার্ড',
  'reset.confirm': 'নতুন পাসওয়ার্ড দিন',
  'reset.confirming': 'আপডেট হচ্ছে…',
  'reset.done': 'পাসওয়ার্ড আপডেট হয়েছে। নতুন পাসওয়ার্ড দিয়ে সাইন ইন করুন।',
  'reset.invalid': 'টোকেনটি সঠিক নয় বা সময় শেষ। নতুন একটি নিন।',
  'reset.backToLogin': 'সাইন ইনে ফিরুন',
  'reset.needToken': 'ইমেইলের রিসেট টোকেন পেস্ট করুন।',
  'reset.emailConfigured': 'অ্যাকাউন্ট থাকলে রিসেট ইমেইল পাঠানো হবে।',
  'reset.notConfigured': 'এই ডেপ্লয়মেন্টে ইমেইল নেই। প্রকল্পের মালিককে জিজ্ঞাসা করুন, বা নিচের ডেভেলপমেন্ট টোকেন ব্যবহার করুন।',

  'onboard.title': 'পড়ার প্রোফাইল সাজান',
  'onboard.lead': 'কয়েকটি তথ্য পরিকল্পনা ও অনুশীলনের পরামর্শ কাজে লাগায়। সবকিছু পরে সেটিংসে বদলানো যায়।',
  'onboard.language': 'ইন্টারফেসের ভাষা',
  'onboard.level': 'পড়ার স্তর',
  'onboard.levelSchool': 'স্কুল',
  'onboard.levelCollege': 'কলেজ',
  'onboard.levelUndergrad': 'স্নাতক',
  'onboard.levelPostgrad': 'স্নাতকোত্তর',
  'onboard.levelSelf': 'স্বশিক্ষিত',
  'onboard.levelOther': 'অন্যান্য',
  'onboard.levelNone': 'বলতে চাই না',
  'onboard.subjects': 'বিষয়',
  'onboard.subjectsHint': 'কমা দিয়ে আলাদা করুন, যেমন: ডেটাবেজ, অ্যালগরিদম, পরিসংখ্যান।',
  'onboard.examDate': 'পরীক্ষার তারিখ',
  'onboard.examDateHint': 'ঐচ্ছিক। পরিকল্পনার কাউন্টডাউনে ব্যবহৃত।',
  'onboard.minutes': 'প্রতিদিন মিনিট',
  'onboard.days': 'সপ্তাহে দিন',
  'onboard.finish': 'সংরক্ষণ করে ড্যাশবোর্ড খুলুন',
  'onboard.skip': 'এখন বাদ দিন',
  'onboard.saving': 'প্রোফাইল সংরক্ষণ হচ্ছে…',
  'onboard.invalidDate': 'তারিখ YYYY-MM-DD আকারে দিন।',
  'onboard.step': 'ধাপ {n} / ২',
  'onboard.next': 'চালিয়ে যান',
  'onboard.back': 'পিছনে',
  'onboard.summaryTitle': 'পড়ার জন্য প্রস্তুত',
  'onboard.summaryLead': 'সবকিছু সেটিংসে বদলানো যায়। উৎসসহ উত্তর ও অনুশীলনের জন্য উপকরণ আপলোড করুন।',
  'onboard.optional': 'ঐচ্ছিক',

  'settings.appearance': 'অ্যাপিয়ারেন্স ও ভাষা',
  'settings.appearanceHint': 'এই ব্রাউজারে এবং সাইন ইন থাকলে অ্যাকাউন্টেও সংরক্ষিত।',
  'settings.profile': 'পড়ার প্রোফাইলের তথ্য',
  'settings.export': 'আমার ডেটা এক্সপোর্ট',
  'settings.exportHint': 'উপকরণের তালিকা, প্যাসেজ, কুইজ, ফ্ল্যাশকার্ড, অগ্রগতি ও পরিকল্পনা JSON হিসেবে ডাউনলোড করুন।',
  'settings.exportButton': 'JSON ডাউনলোড',
  'settings.deleteTitle': 'আমার অ্যাকাউন্ট ও ডেটা মুছে ফেলুন',
  'settings.deleteHint':
    'এটি সব উপকরণ, প্যাসেজ, চ্যাট, কুইজ, প্রচেষ্টা, ফ্ল্যাশকার্ড, ভিজ্যুয়াল, শেখার পথ ও পরিকল্পনা মুছে অ্যাকাউন্টও মুছে ফেলবে। ফেরানো যাবে না।',
  'settings.deleteButton': 'অ্যাকাউন্ট মুছুন',
  'settings.deleteConfirm': 'নিশ্চিত করতে DELETE লিখুন',
  'settings.deletePassword': 'পাসওয়ার্ড দিয়ে নিশ্চিত করুন',
  'settings.deleted': 'আপনার ডেটা মুছে ফেলা হয়েছে।',

  'people.you': 'আপনি',
};

const DICTIONARIES = { en, bn };

export const LANGUAGES = [
  { id: 'en', label: 'English', native: 'English' },
  { id: 'bn', label: 'Bangla', native: 'বাংলা' },
];

export const LANGUAGE_IDS = LANGUAGES.map((language) => language.id);

export function detectLanguage() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (LANGUAGE_IDS.includes(stored)) return stored;
  } catch {
    /* private browsing */
  }
  const browser = typeof navigator !== 'undefined' ? navigator.language ?? '' : '';
  return browser.toLowerCase().startsWith('bn') ? 'bn' : 'en';
}

export function persistLanguage(language) {
  const next = LANGUAGE_IDS.includes(language) ? language : 'en';
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* the choice simply will not persist */
  }
  return next;
}

/** Translate one key; unknown keys fall back to English, then to the key. */
export function translate(language, key, params) {
  const dictionary = DICTIONARIES[language] ?? en;
  const template = dictionary[key] ?? en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

export function createTranslator(language) {
  return (key, params) => translate(language, key, params);
}

export { en, bn };
