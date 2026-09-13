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
