/**
 * i18n — minimal internationalization (zh / en).
 *
 * Pattern matches the platform reference templates (ai-trends / langgraph-quiz):
 *   - Context + Provider + useI18n() hook
 *   - Locale persisted to localStorage
 *   - Default = browser language (navigator.language starts with 'zh' → zh)
 *   - Translations in a single flat object for easy grep
 */
import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export type Locale = 'zh' | 'en';

const translations = {
  zh: {
    // Header
    appTitle: 'AI 邮件管家',
    appSubtitle: 'LangGraph · CrewAI · Human-in-the-loop',

    // Toolbar
    fetchEmails: '拉取邮件',
    aiSmartProcess: 'AI 智能处理',
    stop: '停止',
    newSession: '新会话',
    history: '历史',

    // AI confirm modal
    aiConfirmTitle: 'AI 智能处理',
    aiConfirmBody: 'AI 将从你的收件箱中挑选需要回复的邮件，逐封起草回复并等待你审批。你可以随时停止。',
    aiConfirmCancel: '取消',
    aiConfirmStart: '开始处理',

    // Onboarding
    onboardingTitle: '邮件处理助手',
    onboardingDesc: 'AI 帮你分类邮件、起草回复，你来拍板',
    step1Title: '拉取邮件',
    step1Body: '点击上方「拉取邮件」获取收件箱内容',
    step2Title: '选择处理',
    step2Body: '点击左栏任意邮件的「起草回复」，AI 自动撰写',
    step3Title: '审批确认',
    step3Body: '通过 / 编辑 / 驳回 — 你拥有最终决定权',
    dataSourceLabel: '数据来源',
    providerMock: '模拟数据',
    providerImap: 'IMAP 邮箱',
    providerGmail: 'Gmail',
    providerConnected: '已连接{provider}，将从你的真实收件箱拉取邮件。',
    providerMockDesc: '当前使用模拟数据（10 封预设邮件），可直接体验完整流程。如需连接真实邮箱，请在环境变量中配置 IMAP 信息，详见 README。',
    providerMockBadge: '⚡ 模拟数据模式',
    providerLiveBadge: '✓ 已连接 {provider}',
    aiHint: '不确定要处理哪些？点击工具栏「AI 智能处理」，AI 帮你挑选最该回复的邮件',
    ctaHint: '↑ 点击上方工具栏中对应按钮开始。处理完成后，点击左栏邮件可查看详情和草稿。',

    // Inbox
    inboxTitle: '收件箱',
    inboxHint: '点击邮件查看详情，悬停显示「处理」按钮',
    inboxEmpty: '等待拉取邮件',
    inboxEmptyHint: '点击上方「拉取邮件」开始',
    inboxFetching: '正在拉取邮件...',
    inboxClassifying: '已拉取 {count} 封,正在分类...',
    processBtn: '处理',
    processBtnTitle: '单独处理这一封邮件',
    statusAll: '全部状态',
    statusPending: '待处理',
    statusDone: '已处理',
    allCategories: '全部类别',
    doneLabel: '已处理',
    activeLabel: '审批中',

    // Email categories
    catUrgentCustomer: '紧急客户',
    catMeeting: '会议',
    catInternal: '内部',
    catMarketing: '营销',
    catNotification: '通知',
    catFollowup: '跟进',
    catSpam: '垃圾',
    catBilling: '账单',
    catOther: '其他',

    // Pipeline
    pipelineTitle: '流水线',

    // History sidebar
    historyTitle: '历史会话',
    historyEmpty: '暂无历史',
    historyEmptyHint: '点击「拉取邮件」开始,完成后会自动归档到这里',
    historyRestore: '刷新',
    historyRestoring: '刷新中...',
    historyDeletedRemote: '此会话已在其他设备删除',

    // Status chip
    statusRunning: '运行中',
    statusPaused: '等待审批',
    statusIdle: '就绪',

    // Pipeline nodes
    pipelineFetch: '拉取邮件',
    pipelineClassify: '分类',
    pipelinePrioritize: '排序',
    pipelineDraft: '起草',
    pipelineReview: '审批',
    pipelineApply: '应用',
    pipelineSummarize: '总结',
    pipelineFetchDesc: '从邮箱获取最新邮件',
    pipelineClassifyDesc: 'LLM 批量分类',
    pipelinePrioritizeDesc: '按权重排优先级',
    pipelineDraftDesc: 'CrewAI 三角色协作起草',
    pipelineReviewDesc: '人工审批',
    pipelineApplyDesc: '保存草稿 / 标记',
    pipelineSummarizeDesc: '生成处理摘要',

    // Draft review card
    reviewApprove: '通过',
    reviewRegenerate: '重写',
    reviewSkip: '跳过',
    reviewReject: '不回复',
    reviewEditApprove: '用我改的版本',
    reviewFeedbackPlaceholder: '(可选) 给重写的反馈，比如「语气更正式」',
    reviewPendingLabel: '待审草稿',
    reviewRationale: '为什么这样写?',

    // Message bubble kinds
    kindSystem: '系统',
    kindPipeline: '流水线',
    kindReview: '审批',
    kindDecision: '我',
    kindSummary: '总结',
    kindError: '出错了',
    kindSession: '会话',

    // Misc
    loading: '正在加载会话...',

    // Session / task labels (timeline "Session" bubbles)
    sessionStarted: '会话已开启',
    taskLabelTriage: '仅分类邮件',
    taskLabelDaily: '处理待回邮件',
    taskLabelSingle: '单独处理某封邮件',

    // One-shot task summaries emitted on first prioritize result
    classifyDoneTriage: '📥 已分类 {count} 封邮件 — 仅分类模式不会起草回复,左栏可查看分类详情',
    singleReplyHit: '🎯 单独处理这 1 封邮件,即将起草',
    singleReplyMiss: '🎯 这封邮件没在缓存里 — 试试上方「强制刷新」拉一次',
    digestHasDrafts: '📥 收到 {total} 封邮件,其中 {need} 封需要起草回复 — 接下来会逐封请你审批',
    digestNoDrafts: '📥 收到 {count} 封邮件,本批没有需要起草回复的',

    // HITL review prompt
    reviewPrompt: '请人工审核:{subject}',
    draftNoSubjectHint: '(草稿没标题 — 通常是 LLM 没填好,后端会兜底加 Re:)',

    // Streaming bubble eyebrows
    streamingSummary: '正在写日报…',
    streamingDraft: '正在起草回复…',

    // Run lifecycle
    cancelled: '已取消',
    stopped: '⏹ 已停止',
    backendError: '后端报错',
    checkpointWarning: '⚠ 后端要求重审同一封邮件({id})。\n通常意味着 LangGraph checkpointer 没持久化(本地 dev 默认 in-memory),\n每次请求新进程就丢了之前的状态。',
    restoredToReview: '↩ 已恢复到上次中断的审批位置 — 继续处理这封邮件',
    loadSessionFailed: '加载会话失败: {msg}',

    // Decision echo labels (timeline bubbles for user decisions)
    decApprove: '✓ 通过',
    decApproveEdited: '✓ 通过(编辑)',
    decEdit: '✏️ 用我改的版本',
    decReject: '✗ 不回复',
    decRegenerate: '↻ 重写',
    decRegenerateWith: '↻ 重写:{feedback}',
    decSkip: '↦ 跳过',

    // Runtime status chip (header)
    chipAwaiting: '等待审批',
    chipAwaitingCount: '等待审批 · {i} / {t}',
    chipRunning: '运行中',
    chipRunningCount: '运行中 · {i} / {t}',
    chipDone: '已完成',
    chipDoneCount: '已完成 · {i} / {t}',

    // DraftReviewCard
    noSubjectDraft: '(无主题)',
    draftToLabel: '收件人:',
    draftToneLabel: '语气:',
    draftRemainingPrefix: ' · 还有 ',
    draftRemainingSuffix: ' 封排队',
    draftConfidenceTitle: '模型对此草稿的置信度',

    // EmailDetailDrawer
    drawerAriaLabel: '邮件详情',
    drawerCloseTitle: '关闭 (Esc)',
    drawerCopyDraft: '复制草稿',
    drawerUnknownSender: '(未知发件人)',
    drawerMetaTitle: '邮件信息',
    drawerFrom: '发件人',
    drawerTo: '收件人',
    drawerSubject: '主题',
    drawerTime: '时间',
    drawerAttachment: '附件',
    drawerIcs: '日历邀请 (.ics)',
    drawerClassTitle: 'AI 分类',
    drawerPriority: '优先级 {n}',
    drawerNeedsReply: '需要回复',
    drawerOriginalTitle: '原邮件',
    drawerPlainText: '纯文本',
    drawerEmptyBody: '(邮件正文为空)',
    drawerDraftTitle: '草稿',
    drawerNoDraft: '尚未生成草稿',
    drawerCopy: '复制',
    drawerCopyTitle: '复制到剪贴板',
    drawerCopied: '已复制',

    // EmailInboxTree
    filterToggleTitle: '展开/收起筛选',
    searchPlaceholder: '搜索主题/发件人...',
    clearSearchTitle: '清空搜索',
    filterResult: '显示 {shown} / {total} 封',
    refreshBannerTitle: '新任务正在重新拉取并分类邮件,完成后会刷新这里',
    refreshBannerText: '正在重新拉取...',
    needsReplyTitle: '需要回复',
    noReplyNeededTitle: '不需要回复',

    // NodeFlowVisualizer
    cachedPillTitle: '复用了上次的结果,没有真的访问邮箱 / LLM',
    cachedPillLabel: '缓存',
    nodeActive: '进行中',
    nodePaused: '已暂停',
    nodeDone: '完成',
    nodeError: '出错',

    // HistorySidebar
    historyCurrentSession: '当前会话',
    historySwitchTo: '切换到这个会话',
    historyDeleteTitle: '删除这个会话',
    historyDeleteAria: '删除 {title}',
    historyUntitled: '(无标题)',
    relJustNow: '刚刚',
    relMinutesAgo: '{n} 分钟前',
    relHoursAgo: '{n} 小时前',
    relDaysAgo: '{n} 天前',

    // ChatLayout
    resizeHandleTitle: '拖拽调整宽度',
  },
  en: {
    // Header
    appTitle: 'AI Email Assistant',
    appSubtitle: 'LangGraph · CrewAI · Human-in-the-loop',

    // Toolbar
    fetchEmails: 'Fetch Emails',
    aiSmartProcess: 'AI Smart Process',
    stop: 'Stop',
    newSession: 'New Session',
    history: 'History',

    // AI confirm modal
    aiConfirmTitle: 'AI Smart Process',
    aiConfirmBody: 'AI will pick the emails that need replies, draft responses one by one, and wait for your approval. You can stop at any time.',
    aiConfirmCancel: 'Cancel',
    aiConfirmStart: 'Start',

    // Onboarding
    onboardingTitle: 'Email Assistant',
    onboardingDesc: 'AI classifies your emails, drafts replies — you make the call',
    step1Title: 'Fetch Emails',
    step1Body: 'Click "Fetch Emails" in the toolbar above',
    step2Title: 'Pick & Process',
    step2Body: 'Click "Draft Reply" on any email in the left panel',
    step3Title: 'Review & Approve',
    step3Body: 'Approve / Edit / Reject — you have the final say',
    dataSourceLabel: 'Data Source',
    providerMock: 'Mock Data',
    providerImap: 'IMAP Mailbox',
    providerGmail: 'Gmail',
    providerConnected: 'Connected to {provider}. Will fetch from your real inbox.',
    providerMockDesc: 'Using mock data (10 sample emails). Configure IMAP in environment variables to connect a real mailbox. See README.',
    providerMockBadge: '⚡ Mock Data Mode',
    providerLiveBadge: '✓ Connected to {provider}',
    aiHint: 'Not sure which emails to handle? Click "AI Smart Process" and let AI pick for you',
    ctaHint: '↑ Click the corresponding button in the toolbar above. After processing, click emails in the left panel for details.',

    // Inbox
    inboxTitle: 'Inbox',
    inboxHint: 'Click an email for details, hover for "Process" button',
    inboxEmpty: 'Waiting for emails',
    inboxEmptyHint: 'Click "Fetch Emails" to start',
    inboxFetching: 'Fetching emails...',
    inboxClassifying: 'Fetched {count} emails, classifying...',
    processBtn: 'Process',
    processBtnTitle: 'Process this email individually',
    statusAll: 'All',
    statusPending: 'Pending',
    statusDone: 'Done',
    allCategories: 'All',
    doneLabel: 'Done',
    activeLabel: 'Reviewing',

    // Email categories
    catUrgentCustomer: 'Urgent',
    catMeeting: 'Meeting',
    catInternal: 'Internal',
    catMarketing: 'Marketing',
    catNotification: 'Notification',
    catFollowup: 'Follow-up',
    catSpam: 'Spam',
    catBilling: 'Billing',
    catOther: 'Other',

    // Pipeline
    pipelineTitle: 'Pipeline',

    // History sidebar
    historyTitle: 'History',
    historyEmpty: 'No history',
    historyEmptyHint: 'Sessions will appear here after you process emails',
    historyRestore: 'Refresh',
    historyRestoring: 'Refreshing...',
    historyDeletedRemote: 'This session was deleted on another device',

    // Status chip
    statusRunning: 'Running',
    statusPaused: 'Awaiting Review',
    statusIdle: 'Ready',

    // Pipeline nodes
    pipelineFetch: 'Fetch Emails',
    pipelineClassify: 'Classify',
    pipelinePrioritize: 'Prioritize',
    pipelineDraft: 'Draft',
    pipelineReview: 'Review',
    pipelineApply: 'Apply',
    pipelineSummarize: 'Summarize',
    pipelineFetchDesc: 'Fetch latest emails',
    pipelineClassifyDesc: 'LLM batch classification',
    pipelinePrioritizeDesc: 'Priority scoring',
    pipelineDraftDesc: 'CrewAI three-role drafting',
    pipelineReviewDesc: 'Human approval',
    pipelineApplyDesc: 'Save draft / mark',
    pipelineSummarizeDesc: 'Generate summary',

    // Draft review card
    reviewApprove: 'Approve',
    reviewRegenerate: 'Rewrite',
    reviewSkip: 'Skip',
    reviewReject: 'Reject',
    reviewEditApprove: 'Use my edit',
    reviewFeedbackPlaceholder: '(Optional) Feedback for rewrite, e.g. "more formal tone"',
    reviewPendingLabel: 'Draft for Review',
    reviewRationale: 'Why this reply?',

    // Message bubble kinds
    kindSystem: 'System',
    kindPipeline: 'Pipeline',
    kindReview: 'Review',
    kindDecision: 'Me',
    kindSummary: 'Summary',
    kindError: 'Error',
    kindSession: 'Session',

    // Misc
    loading: 'Loading session...',

    // Session / task labels (timeline "Session" bubbles)
    sessionStarted: 'Session started',
    taskLabelTriage: 'Classify emails only',
    taskLabelDaily: 'Process emails needing replies',
    taskLabelSingle: 'Process a single email',

    // One-shot task summaries emitted on first prioritize result
    classifyDoneTriage: '📥 Classified {count} emails — triage-only mode drafts no replies; see the left panel for details',
    singleReplyHit: '🎯 Processing this 1 email — drafting now',
    singleReplyMiss: '🎯 This email is not in the cache — try "Force Refresh" above',
    digestHasDrafts: '📥 Received {total} emails, {need} need replies — you will review each draft',
    digestNoDrafts: '📥 Received {count} emails, none need a drafted reply',

    // HITL review prompt
    reviewPrompt: 'For manual review: {subject}',
    draftNoSubjectHint: '(draft has no subject — the LLM usually misses it; the backend falls back to Re:)',

    // Streaming bubble eyebrows
    streamingSummary: 'Writing digest…',
    streamingDraft: 'Drafting reply…',

    // Run lifecycle
    cancelled: 'Cancelled',
    stopped: '⏹ Stopped',
    backendError: 'Backend error',
    checkpointWarning: '⚠ The backend asked to re-review the same email ({id}).\nThis usually means the LangGraph checkpointer did not persist (local dev defaults to in-memory)\nand each request starts from a fresh process.',
    restoredToReview: '↩ Restored to the paused review — continue with this email',
    loadSessionFailed: 'Failed to load session: {msg}',

    // Decision echo labels (timeline bubbles for user decisions)
    decApprove: '✓ Approve',
    decApproveEdited: '✓ Approve (edited)',
    decEdit: '✏️ Use my edit',
    decReject: '✗ No reply',
    decRegenerate: '↻ Rewrite',
    decRegenerateWith: '↻ Rewrite: {feedback}',
    decSkip: '↦ Skip',

    // Runtime status chip (header)
    chipAwaiting: 'Awaiting Review',
    chipAwaitingCount: 'Awaiting Review · {i} / {t}',
    chipRunning: 'Running',
    chipRunningCount: 'Running · {i} / {t}',
    chipDone: 'Done',
    chipDoneCount: 'Done · {i} / {t}',

    // DraftReviewCard
    noSubjectDraft: '(no subject)',
    draftToLabel: 'To:',
    draftToneLabel: 'Tone:',
    draftRemainingPrefix: ' · ',
    draftRemainingSuffix: ' more in queue',
    draftConfidenceTitle: "The model's confidence in this draft",

    // EmailDetailDrawer
    drawerAriaLabel: 'Email details',
    drawerCloseTitle: 'Close (Esc)',
    drawerCopyDraft: 'Copy draft',
    drawerUnknownSender: '(unknown sender)',
    drawerMetaTitle: 'Email Info',
    drawerFrom: 'From',
    drawerTo: 'To',
    drawerSubject: 'Subject',
    drawerTime: 'Time',
    drawerAttachment: 'Attachment',
    drawerIcs: 'Calendar invite (.ics)',
    drawerClassTitle: 'AI Classification',
    drawerPriority: 'Priority {n}',
    drawerNeedsReply: 'Needs reply',
    drawerOriginalTitle: 'Original Email',
    drawerPlainText: 'Plain text',
    drawerEmptyBody: '(empty body)',
    drawerDraftTitle: 'Draft',
    drawerNoDraft: 'No draft generated yet',
    drawerCopy: 'Copy',
    drawerCopyTitle: 'Copy to clipboard',
    drawerCopied: 'Copied',

    // EmailInboxTree
    filterToggleTitle: 'Show/hide filters',
    searchPlaceholder: 'Search subject/sender...',
    clearSearchTitle: 'Clear search',
    filterResult: 'Showing {shown} / {total}',
    refreshBannerTitle: 'A new task is re-fetching and classifying emails; this panel refreshes when done',
    refreshBannerText: 'Re-fetching...',
    needsReplyTitle: 'Needs reply',
    noReplyNeededTitle: 'No reply needed',

    // NodeFlowVisualizer
    cachedPillTitle: 'Reused the previous result — no real mailbox / LLM access',
    cachedPillLabel: 'cached',
    nodeActive: 'Active',
    nodePaused: 'Paused',
    nodeDone: 'Done',
    nodeError: 'Error',

    // HistorySidebar
    historyCurrentSession: 'Current session',
    historySwitchTo: 'Switch to this session',
    historyDeleteTitle: 'Delete this session',
    historyDeleteAria: 'Delete {title}',
    historyUntitled: '(untitled)',
    relJustNow: 'just now',
    relMinutesAgo: '{n} min ago',
    relHoursAgo: '{n} h ago',
    relDaysAgo: '{n} d ago',

    // ChatLayout
    resizeHandleTitle: 'Drag to resize',
  },
} as const;

export type TranslationKey = keyof typeof translations['zh'];

interface I18nContextValue {
  locale: Locale;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
  toggleLocale: () => void;
}

const I18nContext = createContext<I18nContextValue>({
  locale: 'zh',
  t: (key) => translations.zh[key],
  toggleLocale: () => {},
});

function detectDefaultLocale(): Locale {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('email-assistant-locale');
    if (saved === 'en' || saved === 'zh') return saved;
    if (navigator.language && !navigator.language.startsWith('zh')) return 'en';
  }
  return 'zh';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(detectDefaultLocale);

  const toggleLocale = useCallback(() => {
    setLocale(prev => {
      const next = prev === 'zh' ? 'en' : 'zh';
      localStorage.setItem('email-assistant-locale', next);
      return next;
    });
  }, []);

  const t = useCallback((key: TranslationKey, vars?: Record<string, string | number>): string => {
    let text: string = translations[locale][key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        text = text.replace(`{${k}}`, String(v));
      }
    }
    return text;
  }, [locale]);

  return (
    <I18nContext.Provider value={{ locale, t, toggleLocale }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
