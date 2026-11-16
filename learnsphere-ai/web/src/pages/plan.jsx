/**
 * Study plan — a student-editable schedule built from their own syllabus,
 * uploaded material and recorded practice.
 *
 * The page shows evidence rather than promises: each topic says which document
 * and page it matched, or that nothing matched; each scheduled task links to a
 * real quiz, document or the existing review queue. Nothing here predicts a
 * grade.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../store/AppContext.jsx';
import { Icon } from '../components/Icons.jsx';
import { Alert, Badge, Button, Card, EmptyState, ErrorPanel, Field, LoadingPanel, StatTile } from '../components/ui.jsx';

const STATUS_TONE = { covered: 'success', needs_practice: 'warning', not_found: 'danger' };
const KINDS = {
  study: { icon: 'lightbulb', label: 'Study' },
  practice: { icon: 'quiz', label: 'Practice' },
  review: { icon: 'clock', label: 'Review' },
};

const isoToday = () => new Date().toISOString().slice(0, 10);
const isoInDays = (days) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

function formatDay(iso, language) {
  const date = new Date(`${iso}T00:00:00Z`);
  return date.toLocaleDateString(language === 'bn' ? 'bn-BD' : 'en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

const DEFAULT_FORM = {
  title: '',
  syllabus: '',
  examDate: isoInDays(21),
  subjects: '',
  minutesPerDay: 40,
  daysPerWeek: 5,
  language: 'auto',
};

function PlanForm({ initial, onSubmit, busy, submitLabel = 'Build my plan', error }) {
  const [form, setForm] = useState(initial ?? DEFAULT_FORM);
  const update = (patch) => setForm((current) => ({ ...current, ...patch }));
  const topics = form.syllabus.split(/\r?\n/).filter((line) => line.trim().length > 1).length;

  return (
    <form
      className="plan-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          title: form.title.trim() || undefined,
          syllabus: form.syllabus,
          examDate: form.examDate,
          subjects: form.subjects
            ? form.subjects
                .split(',')
                .map((subject) => subject.trim())
                .filter(Boolean)
            : undefined,
          minutesPerDay: Number(form.minutesPerDay),
          daysPerWeek: Number(form.daysPerWeek),
          language: form.language,
        });
      }}
    >
      {error ? <ErrorPanel error={error} title="Could not build the plan" /> : null}

      <Field
        label="Syllabus or topic list"
        hint={`One topic per line. ${topics} topic${topics === 1 ? '' : 's'} detected (up to 60).`}
      >
        {({ id, ...aria }) => (
          <textarea
            id={id}
            className="ls-input plan-form__syllabus"
            rows={7}
            required
            value={form.syllabus}
            placeholder={'Transaction handling\nRelational database\nNormalisation\nIndexes'}
            onChange={(event) => update({ syllabus: event.target.value })}
            {...aria}
          />
        )}
      </Field>

      <div className="plan-form__grid">
        <Field label="Exam date" hint="Between today and one year from today.">
          {({ id, ...aria }) => (
            <input
              id={id}
              className="ls-input"
              type="date"
              required
              min={isoToday()}
              max={isoInDays(365)}
              value={form.examDate}
              onChange={(event) => update({ examDate: event.target.value })}
              {...aria}
            />
          )}
        </Field>
        <Field label="Minutes per study day">
          {({ id, ...aria }) => (
            <input
              id={id}
              className="ls-input"
              type="number"
              min={10}
              max={240}
              step={5}
              value={form.minutesPerDay}
              onChange={(event) => update({ minutesPerDay: event.target.value })}
              {...aria}
            />
          )}
        </Field>
        <Field label="Study days per week">
          {({ id, ...aria }) => (
            <select
              id={id}
              className="ls-input"
              value={form.daysPerWeek}
              onChange={(event) => update({ daysPerWeek: event.target.value })}
              {...aria}
            >
              {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                <option key={day} value={day}>
                  {day} day{day === 1 ? '' : 's'}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Preferred language" hint="Bangla changes plan wording and practice; UI text stays bilingual-safe English for now.">
          {({ id, ...aria }) => (
            <select
              id={id}
              className="ls-input"
              value={form.language}
              onChange={(event) => update({ language: event.target.value })}
              {...aria}
            >
              <option value="auto">Follow the material</option>
              <option value="en">English</option>
              <option value="bn">বাংলা (Bangla)</option>
            </select>
          )}
        </Field>
      </div>

      <div className="plan-form__grid">
        <Field label="Plan name" hint="Optional.">
          {({ id, ...aria }) => (
            <input
              id={id}
              className="ls-input"
              type="text"
              maxLength={80}
              value={form.title}
              placeholder="e.g. Database midterm"
              onChange={(event) => update({ title: event.target.value })}
              {...aria}
            />
          )}
        </Field>
        <Field label="Subjects" hint="Optional, comma separated. Shown on the plan only.">
          {({ id, ...aria }) => (
            <input
              id={id}
              className="ls-input"
              type="text"
              value={form.subjects}
              placeholder="Databases, Maths"
              onChange={(event) => update({ subjects: event.target.value })}
              {...aria}
            />
          )}
        </Field>
      </div>

      <div className="row-actions">
        <Button type="submit" icon="route" loading={busy} disabled={topics === 0}>
          {submitLabel}
        </Button>
        <span className="muted-xs">
          Topics are matched against your uploaded documents. Nothing is scheduled for a topic your material does not
          cover.
        </span>
      </div>
    </form>
  );
}

function TopicRow({ topic }) {
  return (
    <li className="plan-topic">
      <div className="plan-topic__head">
        <Badge tone={STATUS_TONE[topic.status] ?? 'neutral'}>{topic.statusLabel}</Badge>
        <span className="plan-topic__title">{topic.title}</span>
        {topic.practiseHref ? (
          <a className="plan-topic__action" href={`#${topic.practiseHref}`}>
            Practise <Icon name="chevronRight" size={13} />
          </a>
        ) : (
          <a className="plan-topic__action" href="#/materials">
            Upload material <Icon name="chevronRight" size={13} />
          </a>
        )}
      </div>
      <p className="plan-topic__why">{topic.why}</p>
      {topic.citations.length > 0 ? (
        <ul className="plan-topic__citations">
          {topic.citations.slice(0, 3).map((citation) => (
            <li key={`${citation.passageId}-${citation.pageNumber}`}>
              <a href={`#/materials?id=${encodeURIComponent(citation.materialId)}`}>
                {citation.documentName}
                {citation.pageNumber ? ` · page ${citation.pageNumber}` : ''}
              </a>
              <span className="muted-xs"> match {Math.round((citation.score ?? 0) * 100)}%</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted-xs">No passage in your uploaded material matched this topic.</p>
      )}
    </li>
  );
}

function TaskRow({ task, onStatus, busyId }) {
  const meta = KINDS[task.kind] ?? { icon: 'check', label: task.kind };
  const busy = busyId === task.id;
  return (
    <li className={`plan-task plan-task--${task.status}`}>
      <label className="plan-task__check">
        <input
          type="checkbox"
          checked={task.status === 'done'}
          disabled={busy}
          onChange={() => onStatus(task, task.status === 'done' ? 'planned' : 'done')}
        />
        <span className="plan-task__body">
          <span className="plan-task__title">
            <Icon name={meta.icon} size={14} /> {task.title}
          </span>
          <span className="plan-task__detail">{task.detail}</span>
          <span className="plan-task__meta">
            {task.minutes} min
            {task.citations?.[0] ? ` · ${task.citations[0].documentName}` : ''}
            {task.status === 'paused' ? ' · paused' : ''}
          </span>
        </span>
      </label>
      <div className="plan-task__actions">
        {task.href ? (
          <a className="plan-task__open" href={`#${task.href}`}>
            Open <Icon name="chevronRight" size={13} />
          </a>
        ) : null}
        {task.status !== 'done' ? (
          <button
            type="button"
            className="linkbtn"
            disabled={busy}
            onClick={() => onStatus(task, task.status === 'paused' ? 'planned' : 'paused')}
          >
            {task.status === 'paused' ? 'Resume' : 'Pause'}
          </button>
        ) : null}
      </div>
    </li>
  );
}

export default function PlanPage({ route }) {
  const { notify } = useApp();
  const [plans, setPlans] = useState([]);
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [taskBusy, setTaskBusy] = useState(null);
  const [formError, setFormError] = useState(null);
  const [editError, setEditError] = useState(null);
  const activeId = useRef(null);

  const loadList = useCallback(async () => {
    const data = await api.listPlans();
    setPlans(data.plans ?? []);
    return data.plans ?? [];
  }, []);

  const loadPlan = useCallback(async (id) => {
    const data = await api.getPlan(id);
    activeId.current = id;
    setPlan(data.plan);
    return data.plan;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const list = await loadList();
        if (cancelled) return;
        const requested = route?.params?.get('id');
        const target = requested && list.some((entry) => entry.id === requested) ? requested : list[0]?.id;
        if (target) await loadPlan(target);
        else setCreating(true);
      } catch (err) {
        if (!cancelled) setError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadList, loadPlan, route]);

  const refreshAll = useCallback(
    async (id) => {
      const list = await loadList();
      const target = id ?? list[0]?.id;
      if (target) await loadPlan(target);
      return list;
    },
    [loadList, loadPlan],
  );

  async function createPlan(input) {
    setBusy(true);
    setFormError(null);
    try {
      const data = await api.createPlan(input);
      setPlan(data.plan);
      setCreating(false);
      await loadList();
      notify('Study plan created from your syllabus and uploaded material.', 'success');
    } catch (err) {
      setFormError(err);
    } finally {
      setBusy(false);
    }
  }

  async function setTaskStatus(task, status) {
    if (!plan) return;
    setTaskBusy(task.id);
    try {
      const data = await api.setPlanTask(plan.id, task.id, status);
      setPlan(data.plan);
    } catch (err) {
      notify(err.message ?? 'Could not update the task.', 'error');
    } finally {
      setTaskBusy(null);
    }
  }

  async function editPlan(patch) {
    if (!plan) return;
    setBusy(true);
    setEditError(null);
    try {
      const data = await api.updatePlan(plan.id, patch);
      setPlan(data.plan);
      await loadList();
      notify('Plan updated. Completed tasks were kept.', 'success');
    } catch (err) {
      setEditError(err);
    } finally {
      setBusy(false);
    }
  }

  async function refreshPlan() {
    if (!plan) return;
    setBusy(true);
    try {
      const data = await api.refreshPlan(plan.id);
      setPlan(data.plan);
      notify('Coverage and evidence re-read from your documents and recorded practice.', 'success');
    } catch (err) {
      notify(err.message ?? 'Could not refresh the plan.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function removePlan() {
    if (!plan) return;
    if (!window.confirm('Delete this study plan? Your materials, quizzes and review dates are not touched.')) return;
    setBusy(true);
    try {
      await api.deletePlan(plan.id);
      setPlan(null);
      setCreating(true);
      await refreshAll();
      notify('Study plan deleted. Your documents and practice records are unchanged.', 'success');
    } catch (err) {
      notify(err.message ?? 'Could not delete the plan.', 'error');
    } finally {
      setBusy(false);
    }
  }

  const daysUntilExam = useMemo(() => {
    if (!plan) return null;
    const today = isoToday();
    return Math.round((Date.parse(`${plan.examDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  }, [plan]);

  const summary = plan?.summary ?? null;

  if (loading) return <LoadingPanel label="Loading your study plan" rows={4} />;
  if (error) return <ErrorPanel error={error} title="Could not load your plan" onRetry={() => window.location.reload()} />;

  return (
    <div className="page">
      {plans.length > 1 || plan ? (
        <div className="plan-switcher">
          <label htmlFor="plan-select" className="muted-xs">
            Your plans
          </label>
          <select
            id="plan-select"
            className="ls-input"
            value={plan?.id ?? ''}
            onChange={async (event) => {
              if (event.target.value === '__new') {
                setCreating(true);
                setPlan(null);
                return;
              }
              setCreating(false);
              await loadPlan(event.target.value);
            }}
          >
            {plans.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title} · {entry.examDate}
              </option>
            ))}
            <option value="__new">+ New plan</option>
          </select>
          <Button variant="ghost" size="sm" icon="plus" onClick={() => { setCreating(true); setPlan(null); }}>
            New plan
          </Button>
        </div>
      ) : null}

      {creating || !plan ? (
        <Card
          title={plans.length === 0 ? 'Plan your exam from your own material' : 'New study plan'}
          subtitle="Paste a syllabus or topic list, set your exam date and study time. Nothing is scheduled for a topic your documents do not cover."
        >
          <PlanForm
            key={plan?.id ?? 'new'}
            initial={plan ? {
              title: plan.title,
              syllabus: plan.topics.map((topic) => topic.title).join('\n'),
              examDate: plan.examDate,
              subjects: (plan.subjects ?? []).join(', '),
              minutesPerDay: plan.minutesPerDay,
              daysPerWeek: plan.daysPerWeek,
              language: plan.language,
            } : DEFAULT_FORM}
            onSubmit={createPlan}
            busy={busy}
            submitLabel={plan ? 'Create a separate plan' : 'Build my plan'}
            error={formError}
          />
          {plan ? (
            <div className="row-actions">
              <Button variant="ghost" icon="chevronLeft" onClick={() => setCreating(false)}>
                Back to the current plan
              </Button>
            </div>
          ) : null}
        </Card>
      ) : (
        <>
          <Card
            title={plan.title}
            subtitle={`Exam ${plan.examDate}${daysUntilExam != null ? ` · in ${Math.max(0, daysUntilExam)} day${daysUntilExam === 1 ? '' : 's'}` : ''} · ${plan.minutesPerDay} min on ${plan.daysPerWeek} day(s)/week`}
            actions={
              <div className="row-actions">
                <Button variant="ghost" size="sm" icon="refresh" loading={busy} onClick={refreshPlan}>
                  Refresh from evidence
                </Button>
                <Button variant="ghost" size="sm" icon="trash" onClick={removePlan}>
                  Delete
                </Button>
              </div>
            }
          >
            <div className="stat-row stat-row--compact">
              <StatTile label="Topics in material" value={summary?.covered ?? 0} icon="check" hint="Matched a document" />
              <StatTile label="Need practice" value={summary?.needsPractice ?? 0} icon="target" hint="From recorded answers" />
              <StatTile label="Not found" value={summary?.notFound ?? 0} icon="alert" hint="No matching passage" />
              <StatTile
                label="Done"
                value={`${summary?.doneTasks ?? 0}/${summary?.totalTasks ?? 0}`}
                icon="quiz"
                hint={`${summary?.scheduledDays ?? 0} study day(s) planned`}
              />
            </div>

            <div className="plan-actions">
              <a className="linkbtn" href="#/coach">Exam coach <Icon name="chevronRight" size={13} /></a>
              <a className="linkbtn" href="#/review">Due for review <Icon name="chevronRight" size={13} /></a>
              <a className="linkbtn" href="#/progress">Progress <Icon name="chevronRight" size={13} /></a>
              <a className="linkbtn" href="#/dna">Learning DNA <Icon name="chevronRight" size={13} /></a>
            </div>

            <Alert tone="info" title="What this plan is, and is not">
              <p>{plan.disclaimer}</p>
            </Alert>
          </Card>

          <Card title="Topic coverage" subtitle="Each topic is matched against your indexed documents; page numbers come from the extracted text.">
            <ul className="plan-topics">
              {plan.topics.map((topic) => (
                <TopicRow key={topic.id} topic={topic} />
              ))}
            </ul>
          </Card>

          {plan.gaps.length > 0 ? (
            <Card title="Not in your uploaded material" subtitle="These topics are reported as gaps, not scheduled as study.">
              <ul className="ls-list">
                {plan.gaps.map((gap) => (
                  <li key={gap.title}>
                    <strong>{gap.title}</strong> — {gap.why}
                  </li>
                ))}
              </ul>
              <p className="muted-xs">
                Upload the lecture notes or textbook chapter that covers them, then use “Refresh from evidence”. The plan
                will not pretend the material covers them in the meantime.
              </p>
            </Card>
          ) : null}

          <Card
            title="Daily schedule"
            subtitle="Tick a task when it is done, or pause it. Completed tasks survive an edit or refresh."
          >
            {plan.days.length === 0 ? (
              <EmptyState
                icon="route"
                title="Nothing scheduled yet"
                description="No topic in this plan matched your uploaded material, so there is nothing honest to schedule. Upload material first, then refresh the plan."
              />
            ) : (
              <div className="plan-days">
                {plan.days.map((day) => (
                  <section key={day.date} className="plan-day">
                    <h3 className="plan-day__head">
                      {formatDay(day.date, plan.language)}
                      <span className="muted-xs">
                        {day.tasks.reduce((sum, task) => sum + (task.minutes || 0), 0)} min ·{' '}
                        {day.tasks.filter((task) => task.status === 'done').length}/{day.tasks.length} done
                      </span>
                    </h3>
                    <ul className="plan-tasks">
                      {day.tasks.map((task) => (
                        <TaskRow key={task.id} task={task} onStatus={setTaskStatus} busyId={taskBusy} />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </Card>

          <Card title="Edit this plan" subtitle="Changing these settings rebuilds the schedule; done and paused tasks are kept.">
            <PlanForm
              key={plan.id}
              initial={{
                title: plan.title,
                syllabus: plan.topics.map((topic) => topic.title).join('\n'),
                examDate: plan.examDate,
                subjects: (plan.subjects ?? []).join(', '),
                minutesPerDay: plan.minutesPerDay,
                daysPerWeek: plan.daysPerWeek,
                language: plan.language,
              }}
              onSubmit={editPlan}
              busy={busy}
              submitLabel="Save changes"
              error={editError}
            />
          </Card>

          <Card title="Assumptions" subtitle="The plan states its own limits.">
            <ul className="ls-list ls-list--compact">
              {(plan.assumptions ?? []).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="muted-xs">{plan.disclaimer}</p>
          </Card>
        </>
      )}
    </div>
  );
}
