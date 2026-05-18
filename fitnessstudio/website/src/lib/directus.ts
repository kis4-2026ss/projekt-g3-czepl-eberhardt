// process.env is the reliable source inside Docker; import.meta.env can be
// baked as undefined by Vite when the variable isn't in a .env file.
const BASE = (
  import.meta.env.DIRECTUS_URL ??
  process.env['DIRECTUS_URL'] ??
  'http://localhost:8056'
).replace(/\/$/, '');

const TOKEN: string =
  import.meta.env.DIRECTUS_TOKEN ||
  process.env['DIRECTUS_TOKEN'] ||
  '';

const PUBLIC_BASE = (
  import.meta.env.PUBLIC_DIRECTUS_URL ??
  process.env['PUBLIC_DIRECTUS_URL'] ??
  'http://localhost:8056'
).replace(/\/$/, '');

async function get<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;

  const res = await fetch(`${BASE}${path}`, { headers, cache: 'no-store' });

  if (res.status === 403) {
    throw new Error(
      `Directus returned 403 for "${path}". ` +
      `Either set DIRECTUS_TOKEN in .env or enable public Read access.`,
    );
  }
  if (!res.ok) {
    throw new Error(`Directus ${path} → HTTP ${res.status}`);
  }
  return ((await res.json()) as { data: T }).data;
}

/** Build a browser-reachable URL for a Directus file uuid. */
export function assetUrl(id: string | null | undefined, params = ''): string {
  if (!id) return '';
  const qs = params ? `?${params}` : '';
  return `${PUBLIC_BASE}/assets/${id}${qs}`;
}

/** Minimal markdown subset: paragraphs + **bold**. */
export function md(text: string | null | undefined): string {
  if (!text) return '';
  return (
    '<p>' +
    text
      .trim()
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .split(/\n\n+/)
      .join('</p><p>') +
    '</p>'
  );
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface SiteSettings {
  site_name: string;
  tagline: string;
  contact_email: string;
  contact_phone: string;
  address_street: string;
  address_zip: string;
  address_city: string;
  google_maps_url: string;
  instagram_url: string;
  footer_note: string;
}

export interface SiteStats {
  member_count: string;
  member_label: string;
  courses_per_week: string;
  courses_label: string;
  trainer_count: string;
  trainer_label: string;
  founded_year: number;
  founded_label: string;
  studio_area: string;
  studio_area_label: string;
  rating: string;
  rating_label: string;
  trainer_about_count: string;
  trainer_about_label: string;
}

export interface Hero {
  eyebrow: string;
  headline: string;
  subheadline: string;
  cta_primary_label: string;
  cta_primary_link: string;
  cta_secondary_label: string;
  cta_secondary_link: string;
  image_alt: string;
  image: string | null;
}

export interface About {
  eyebrow: string;
  title: string;
  lead: string;
  body: string;
  team_link_label: string;
  team_link_href: string;
  image: string | null;
  image_alt: string;
}

export interface NavigationLink {
  id: number;
  href: string;
  label: string;
  sort: number;
}

export interface UiCopy {
  nav_cta_label: string;
  nav_cta_href: string;
  footer_nav_title: string;
  footer_contact_title: string;
  footer_hours_title: string;
  footer_maps_label: string;
  footer_rights_template: string;
  footer_legal_line: string;
  closed_label: string;
  trial_label: string;
  popular_label: string;
  per_month_label: string;
  difficulty_label_leicht: string;
  difficulty_label_mittel: string;
  difficulty_label_intensiv: string;
  minutes_label: string;
  trainer_label: string;
  more_label: string;
  all_categories_label: string;
  phone_label: string;
  email_label: string;
  address_label: string;
  directions_label: string;
}

export interface HomeCopy {
  classes_eyebrow: string;
  classes_title: string;
  classes_lead: string;
  classes_all_link_label: string;
  pricing_eyebrow: string;
  pricing_title: string;
  pricing_lead: string;
  pricing_footnote: string;
  pricing_all_link_label: string;
  testimonials_eyebrow: string;
  testimonials_title: string;
  hours_eyebrow: string;
  hours_title: string;
  hours_cta_label: string;
}

export interface KurseCopy {
  eyebrow: string;
  title: string;
  lead: string;
}

export interface MitgliedschaftCopy {
  eyebrow: string;
  title: string;
  subtitle: string;
  lead: string;
  footnote: string;
  faq_eyebrow: string;
  faq_title: string;
  banner_title: string;
  banner_text: string;
  banner_cta: string;
  banner_link: string;
}

export interface KontaktCopy {
  eyebrow: string;
  title: string;
  lead: string;
  hours_title: string;
  trial_title: string;
  trial_text: string;
  trial_cta: string;
  trial_link: string;
}

export interface ClassCategory {
  id: number;
  name: string;
  slug: string;
  description: string;
  sort: number;
}

export interface FitClass {
  id: number;
  name: string;
  description: string;
  duration_min: number;
  difficulty: 'leicht' | 'mittel' | 'intensiv';
  is_featured: boolean;
  image: string | null;
  image_alt: string;
  category: ClassCategory | null;
  trainer_name: string;
  schedule_note: string;
  sort: number;
}

export interface MembershipPlanFeature {
  label: string;
  included: boolean;
}

export interface MembershipPlan {
  id: number;
  name: string;
  tagline: string;
  price_monthly: number | string;
  billing_note: string;
  features: MembershipPlanFeature[];
  is_highlighted: boolean;
  highlight_label: string;
  cta_label: string;
  cta_link: string;
  sort: number;
}

export interface OpeningHour {
  id: number;
  weekday: string;
  sort: number;
  closed: boolean;
  open_from: string;
  open_to: string;
  note: string;
}

export interface Testimonial {
  id: number;
  author: string;
  membership_type: string;
  rating: number;
  quote: string;
  sort: number;
}

export interface FaqItem {
  id: number;
  question: string;
  sort: number;
  answer: string;
}

// ── Fetchers ─────────────────────────────────────────────────────────────────

export const getSiteSettings        = () => get<SiteSettings>('/items/site_settings');
export const getSiteStats           = () => get<SiteStats>('/items/site_stats');
export const getHero                = () => get<Hero>('/items/hero');
export const getAbout               = () => get<About>('/items/about');
export const getNavigation          = () => get<NavigationLink[]>('/items/navigation_links?sort=sort');
export const getUiCopy              = () => get<UiCopy>('/items/ui_copy');
export const getHomeCopy            = () => get<HomeCopy>('/items/home_copy');
export const getKurseCopy           = () => get<KurseCopy>('/items/kurse_copy');
export const getMitgliedschaftCopy  = () => get<MitgliedschaftCopy>('/items/mitgliedschaft_copy');
export const getKontaktCopy         = () => get<KontaktCopy>('/items/kontakt_copy');
export const getClassCategories     = () => get<ClassCategory[]>('/items/class_categories?sort=sort');
export const getMembershipPlans     = () => get<MembershipPlan[]>('/items/membership_plans?sort=sort');
export const getOpeningHours        = () => get<OpeningHour[]>('/items/opening_hours?sort=sort');
export const getTestimonials        = () => get<Testimonial[]>('/items/testimonials?sort=sort');
export const getFaqItems            = () => get<FaqItem[]>('/items/faq_items?sort=sort');

export const getClasses = () =>
  get<FitClass[]>(
    '/items/classes?fields=*,category.*&limit=-1&sort=sort,name',
  );

export const getFeaturedClasses = () =>
  get<FitClass[]>(
    '/items/classes?filter[is_featured][_eq]=true&fields=*,category.*&limit=6&sort=sort,name',
  );

// ── Helpers ──────────────────────────────────────────────────────────────────

export function difficultyDots(level: FitClass['difficulty']): number {
  if (level === 'leicht') return 1;
  if (level === 'intensiv') return 3;
  return 2;
}

export function difficultyLabel(level: FitClass['difficulty'], ui: UiCopy): string {
  if (level === 'leicht') return ui.difficulty_label_leicht;
  if (level === 'intensiv') return ui.difficulty_label_intensiv;
  return ui.difficulty_label_mittel;
}

export function formatPrice(price: number | string): string {
  const n = typeof price === 'string' ? Number(price) : price;
  if (!Number.isFinite(n)) return String(price);
  return n.toLocaleString('de-AT', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
