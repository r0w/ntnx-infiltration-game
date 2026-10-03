// Self-Service jobs use action.spec.uuid, as in Calm DSL's APP_ACTION_RUN.
type App = { spec?: { resources?: { action_list?: Array<{ name?: string; uuid?: string }> } } };
type JobResources = {
  type?: string;
  state?: string;
  schedule_info?: { schedule?: string };
  executable?: { entity?: { uuid?: string; type?: string }; action?: { type?: string; spec?: { uuid?: string } } };
};

export function refreshAction(app: App): { uuid: string } {
  const action = app.spec?.resources?.action_list?.find(a => a.name === 'Refresh VM');
  if (!action?.uuid) throw new Error('Application action Refresh VM not found');
  return { uuid: action.uuid };
}

export function dailyScheduleError(job: JobResources | undefined, appUuid: string, actionUuid: string): string | undefined {
  if (job?.executable?.entity?.uuid !== appUuid) return 'select the player application.';
  if (job.executable.action?.type !== 'APP_ACTION_RUN' || job.executable.action.spec?.uuid !== actionUuid) {
    return 'select the Refresh VM action.';
  }
  const cron = job.schedule_info?.schedule?.trim().split(/\s+/) ?? [];
  const minute = cron[0] ?? '';
  const hour = cron[1] ?? '';
  if (job.type !== 'RECURRING' || cron.length !== 5 || !/^\d+$/.test(minute) || +minute > 59 ||
      !/^\d+$/.test(hour) || +hour > 23 || !cron.slice(2).every(v => v === '*')) {
    return 'schedule it once every day.';
  }
  if (job.state && job.state !== 'ACTIVE') return 'enable the schedule.';
}

/** Auto-play schedules reports at 03:00 UTC. */
export function nextReportTime(now = new Date()): string {
  const start = new Date(now);
  start.setUTCHours(3, 0, 0, 0);
  if (start <= now) start.setUTCDate(start.getUTCDate() + 1);
  return start.toISOString();
}

/** The report timezone is not graded: 03:00 counts whether Prism stored the
 * start as a UTC instant or converted it from the selected timezone. */
export function reportRunsAtThree(startTime?: string, timezone?: string): boolean {
  if (!startTime) return false;
  const start = new Date(startTime);
  if (Number.isNaN(start.getTime())) return false;
  return ['UTC', timezone].some(timeZone => {
    if (!timeZone) return false;
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).format(start) === '03:00';
    } catch { return false; }
  });
}

/** GET responses include union discriminators that report PUT rejects. */
export function reportWriteBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reportWriteBody);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== '$reserved' && !/^\$.*ItemDiscriminator$/.test(key))
      .map(([key, item]) => [key, reportWriteBody(item)]));
  }
  return value;
}
