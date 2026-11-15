// Ignore delayed updates from jobs that have already been superseded.
export function createCaptureStatusTracker() {
  let jobId = null;
  let revision = 0;
  const previousJobs = new Set();
  return {
    current() { return { jobId, revision }; },
    accept(status) {
      if (status?.jobId && status.jobId !== jobId) {
        if (previousJobs.has(status.jobId)) return false;
        if (jobId) previousJobs.add(jobId);
        jobId = status.jobId;
        revision = 0;
      }
      if (status?.revision && status.revision < revision) return false;
      if (status?.revision) revision = status.revision;
      return true;
    }
  };
}
