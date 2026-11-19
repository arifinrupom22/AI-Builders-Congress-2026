/**
 * Study-plan routes.
 *
 * Every handler is scoped to `req.learnerId`; a plan id that belongs to another
 * profile answers 404, exactly as if it did not exist.
 */
import express from 'express';
import { z } from 'zod';
import AppError from '../errors.js';
import { parseBody } from './validate.js';
import { PLAN_DISCLAIMER, daysBetween, isIsoDate } from '../planner/service.js';

const examDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in YYYY-MM-DD form.');
const syllabus = z.string().trim().min(3, 'Add at least one topic.').max(8000);
const minutesPerDay = z.coerce.number().int().min(10, 'Plan at least 10 minutes a day.').max(240);
const daysPerWeek = z.coerce.number().int().min(1).max(7);
const language = z.enum(['auto', 'en', 'bn']);
const subjects = z.array(z.string().trim().min(1).max(40)).max(12);

const createBody = z.object({
  title: z.string().trim().max(80).optional(),
  syllabus,
  examDate,
  subjects: subjects.optional(),
  minutesPerDay: minutesPerDay.default(40),
  daysPerWeek: daysPerWeek.default(5),
  language: language.default('auto'),
});

const updateBody = z.object({
  title: z.string().trim().max(80).optional(),
  syllabus: syllabus.optional(),
  examDate: examDate.optional(),
  subjects: subjects.optional(),
  minutesPerDay: minutesPerDay.optional(),
  daysPerWeek: daysPerWeek.optional(),
  language: language.optional(),
});

const taskBody = z.object({ status: z.enum(['planned', 'done', 'paused']) });

/** Today .. one year out. A plan for yesterday is not a plan. */
function assertPlannerDate(value) {
  if (!isIsoDate(value)) throw AppError.badRequest('Use a real calendar date in YYYY-MM-DD form.');
  const today = new Date().toISOString().slice(0, 10);
  const offset = daysBetween(today, value);
  if (offset < 0) throw AppError.badRequest('The exam date cannot be in the past.');
  if (offset > 365) throw AppError.badRequest('Plan at most one year ahead.');
  return value;
}

export function plannerRouter({ plannerService }) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    const body = parseBody(createBody, req.body);
    assertPlannerDate(body.examDate);
    const plan = await plannerService.create({ learnerId: req.learnerId, input: body });
    req.log.info('study plan created', {
      planId: plan.id,
      topics: plan.topics.length,
      scheduledDays: plan.days.length,
    });
    res.status(201).json({
      plan,
      note: 'Topics are matched against your own indexed documents. "Covered" means a document contains the topic; it is not a claim that you have learned it.',
    });
  });

  router.get('/', async (req, res) => {
    const plans = await plannerService.list(req.learnerId);
    res.json({ plans, disclaimer: PLAN_DISCLAIMER });
  });

  router.get('/today', async (req, res) => {
    const today = await plannerService.todayFor(req.learnerId);
    res.json({ today, disclaimer: PLAN_DISCLAIMER });
  });

  router.get('/:id', async (req, res) => {
    const plan = await plannerService.get(req.learnerId, req.params.id);
    if (!plan) throw AppError.notFound('That study plan is not in your library.');
    res.json({ plan, disclaimer: PLAN_DISCLAIMER });
  });

  router.patch('/:id', async (req, res) => {
    const body = parseBody(updateBody, req.body);
    if (body.examDate) assertPlannerDate(body.examDate);
    const plan = await plannerService.update({ learnerId: req.learnerId, id: req.params.id, patch: body });
    if (!plan) throw AppError.notFound('That study plan is not in your library.');
    req.log.info('study plan edited', { planId: plan.id, fields: Object.keys(body) });
    res.json({
      plan,
      note: 'The schedule was rebuilt from the edited settings. Tasks you already marked done stay done.',
    });
  });

  router.patch('/:id/tasks/:taskId', async (req, res) => {
    const body = parseBody(taskBody, req.body);
    const result = await plannerService.setTask({
      learnerId: req.learnerId,
      id: req.params.id,
      taskId: req.params.taskId,
      status: body.status,
    });
    if (!result) throw AppError.notFound('That task or study plan was not found.');
    if (!result.task) throw AppError.notFound('That task is not part of this study plan.');
    res.json({ plan: result.plan, task: result.task });
  });

  router.post('/:id/refresh', async (req, res) => {
    const plan = await plannerService.refreshPlan({ learnerId: req.learnerId, id: req.params.id });
    if (!plan) throw AppError.notFound('That study plan is not in your library.');
    res.json({
      plan,
      note: 'Coverage and practice evidence were re-read from your documents and recorded answers. Completed tasks were kept.',
    });
  });

  router.delete('/:id', async (req, res) => {
    const removed = await plannerService.remove({ learnerId: req.learnerId, id: req.params.id });
    if (!removed) throw AppError.notFound('That study plan is not in your library.');
    res.json({ deleted: true, planId: req.params.id });
  });

  return router;
}

export default plannerRouter;
