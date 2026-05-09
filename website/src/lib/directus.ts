// process.env is the reliable source inside Docker; import.meta.env can be
// baked as undefined by Vite when the variable isn't in a .env file.
const BASE = (
  import.meta.env.DIRECTUS_URL ??
  process.env['DIRECTUS_URL'] ??
  'http://localhost:8055'
).replace(/\/$/, '');

const TOKEN: string =
  import.meta.env.DIRECTUS_TOKEN ||
  process.env['DIRECTUS_TOKEN'] ||
  '';

async function get<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;

  const res = await fetch(`${BASE}${path}`, { headers, cache: 'no-store' });

  if (res.status === 403) {
    throw new Error(
      `Directus returned 403 for "${path}". ` +
      `Either set DIRECTUS_TOKEN in .env or enable public Read access: ` +
      `Directus → Settings → Roles → Public → enable Read on all collections.`,
    );
  }
  if (!res.ok) {
    throw new Error(`Directus ${path} → HTTP ${res.status}`);
  }
  return ((await res.json()) as { data: T }).data;
}

// Public URL used in <img src> — must be reachable by the browser, not the Docker-internal host.
const PUBLIC_BASE = (
  import.meta.env.PUBLIC_DIRECTUS_URL ??
  process.env['PUBLIC_DIRECTUS_URL'] ??
  'http://localhost:8055'
).replace(/\/$/, '');

/** Returns the Directus asset URL for a file UUID, using the browser-accessible host. */
export function assetUrl(id: string | null | undefined): string {
  if (!id) return '';
  return `${PUBLIC_BASE}/assets/${id}`;
}

/** Renders our simple markdown subset (paragraphs + **bold**) to HTML. */
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
  facebook_url: string;
  footer_note: string;
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
  footer_maps_label: string;
  footer_rights_template: string;
  footer_since_line: string;
  vegetarian_label: string;
  vegan_label: string;
  closed_label: string;
  kitchen_label: string;
  address_label: string;
  phone_label: string;
  email_label: string;
  phone_hours_note: string;
  maps_short_label: string;
  recurring_label: string;
  no_details_text: string;
}

export interface SpeisekarteCopy {
  allergen_title: string;
  allergen_note: string;
  allergen_disclaimer: string;
}

export interface KontaktCopy {
  hours_title: string;
  hours_subtitle: string;
  hours_footer_note: string;
  reservation_eyebrow: string;
  reservation_title: string;
  reservation_text: string;
  reservation_cta_label: string;
  seo_description_template: string;
}

export interface FaqCopy {
  help_eyebrow: string;
  help_title: string;
  help_text: string;
  help_cta_label: string;
  help_cta_href: string;
}

export interface UeberUnsCopy {
  story_eyebrow: string;
  philosophy_eyebrow: string;
  team_eyebrow: string;
  team_title: string;
}

export interface HomeCopy {
  featured_eyebrow: string;
  featured_title: string;
  featured_all_link_label: string;
  about_eyebrow: string;
  about_link_label: string;
  founded_label: string;
  generation_label: string;
  testimonials_eyebrow: string;
  testimonials_title: string;
  events_eyebrow: string;
  events_title: string;
  events_all_link_label: string;
  opening_hours_eyebrow: string;
  opening_hours_title: string;
  opening_hours_link_label: string;
}

export interface PageHeader {
  id: number;
  slug: string;
  title: string;
  eyebrow: string;
  lead: string;
  seo_description: string;
  image: string | null;
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
  title: string;
  subtitle: string;
  story: string;
  philosophy: string;
  founded_year: number;
  generations: number;
  image: string | null;
}

export interface Category {
  id: number;
  name: string;
  sort: number;
  description: string;
}

export interface MenuItem {
  id: number;
  name: string;
  description: string;
  price: number;
  is_vegetarian: boolean;
  is_vegan: boolean;
  available: boolean;
  is_featured: boolean;
  allergens: string[] | null;
  category: Category;
}

export interface TeamMember {
  id: number;
  first_name: string;
  last_name: string;
  role: string;
  sort: number;
  bio: string;
}

export interface Testimonial {
  id: number;
  author: string;
  location: string;
  rating: number;
  quote: string;
  sort: number;
  published_on: string;
}

export interface Event {
  id: number;
  title: string;
  subtitle: string;
  description: string;
  starts_on: string | null;
  ends_on: string | null;
  is_recurring: boolean;
  recurrence_note: string;
}

export interface OpeningHour {
  id: number;
  weekday: string;
  sort: number;
  closed: boolean;
  open_from: string;
  open_to: string;
  kitchen_from: string;
  kitchen_to: string;
  note: string;
}

export interface FaqItem {
  id: number;
  question: string;
  sort: number;
  answer: string;
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

export const getSiteSettings  = () => get<SiteSettings>('/items/site_settings');
export const getHero           = () => get<Hero>('/items/hero');
export const getAbout          = () => get<About>('/items/about');
export const getNavigation     = () => get<NavigationLink[]>('/items/navigation_links?sort=sort');
export const getUiCopy         = () => get<UiCopy>('/items/ui_copy');
export const getHomeCopy       = () => get<HomeCopy>('/items/home_copy');
export const getSpeisekarteCopy = () => get<SpeisekarteCopy>('/items/speisekarte_copy');
export const getKontaktCopy     = () => get<KontaktCopy>('/items/kontakt_copy');
export const getFaqCopy         = () => get<FaqCopy>('/items/faq_copy');
export const getUeberUnsCopy    = () => get<UeberUnsCopy>('/items/ueber_uns_copy');
export const getPageHeader     = (slug: string) =>
  get<PageHeader[]>(
    `/items/page_headers?filter[slug][_eq]=${encodeURIComponent(slug)}&limit=1`,
  ).then((rows) => rows[0]);
export const getTeam           = () => get<TeamMember[]>('/items/team?sort=sort');
export const getTestimonials   = () => get<Testimonial[]>('/items/testimonials?sort=sort');
export const getOpeningHours   = () => get<OpeningHour[]>('/items/opening_hours?sort=sort');
export const getFaq            = () => get<FaqItem[]>('/items/faq?sort=sort');
export const getEvents         = () => get<Event[]>('/items/events?sort=starts_on');
export const getCategories     = () => get<Category[]>('/items/categories?sort=sort');

export const getMenuItems = () =>
  get<MenuItem[]>('/items/menu_items?fields=*,category.*&limit=-1&sort=category.sort,name');

export const getFeaturedDishes = () =>
  get<MenuItem[]>(
    '/items/menu_items?filter[is_featured][_eq]=true&fields=*,category.name&limit=6',
  );
