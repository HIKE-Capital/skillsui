/**
 * Sources whose skill listing lives on a dedicated page instead of the site
 * root. Used for the group-header link target and, server-side, as the page
 * to parse for a favicon when the site root does not declare one.
 */
export const SOURCE_LANDING_PAGES: Record<string, string> = {
  'q.hikecapital.com': 'https://q.hikecapital.com/skills',
  'open.feishu.cn': 'https://feishucli.net/',
};
