import { supabase } from '@/lib/supabase';

export interface JobOverride {
  job_id: number;
  product_name: string | null;
  rated_speed: number | null;
}

export async function loadJobOverride(jobId: number): Promise<JobOverride | null> {
  const { data, error } = await supabase
    .from('job_overrides')
    .select('job_id, product_name, rated_speed')
    .eq('job_id', jobId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as JobOverride) ?? null;
}

export async function fetchOverridesForJobs(jobIds: number[]): Promise<JobOverride[]> {
  if (jobIds.length === 0) return [];
  const { data, error } = await supabase
    .from('job_overrides')
    .select('job_id, product_name, rated_speed')
    .in('job_id', jobIds);

  if (error) throw new Error(error.message);
  return (data as JobOverride[]) ?? [];
}

export async function saveJobOverride(
  jobId: number,
  productName: string,
  ratedSpeed: number,
): Promise<void> {
  const { error } = await supabase
    .from('job_overrides')
    .upsert(
      {
        job_id: jobId,
        product_name: productName,
        rated_speed: ratedSpeed,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'job_id' },
    );

  if (error) throw new Error(error.message);
}

export async function deleteJobOverride(jobId: number): Promise<void> {
  const { error } = await supabase
    .from('job_overrides')
    .delete()
    .eq('job_id', jobId);

  if (error) throw new Error(error.message);
}
