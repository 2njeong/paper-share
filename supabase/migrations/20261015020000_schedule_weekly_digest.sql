create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 매주 금요일 02:00 UTC = 11:00 KST
select cron.schedule(
  'paper-share-weekly-digest',
  '0 2 * * 5',
  $$
  select net.http_post(
    url := 'https://lbxikwbpdspbaqvsxgnn.supabase.co/functions/v1/paper-share-digest',
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  $$
);
