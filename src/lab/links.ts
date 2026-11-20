/* Page chrome: the name top-left and the link icons bottom-right. */
export const NAME = 'Noah Menendez';
export type LinkIcon = 'linkedin' | 'email' | 'instagram';
export const LINKS: { label: string; icon: LinkIcon; url: string }[] = [
  { label: 'LinkedIn', icon: 'linkedin', url: 'https://www.linkedin.com/in/noahmenendez/' },
  { label: 'Email', icon: 'email', url: 'mailto:noahmenendez90@gmail.com' },
  { label: 'Instagram', icon: 'instagram', url: 'https://www.instagram.com/noah.menendez' },
  // Résumé button removed (Nov 20) until the PDF is ready: add { label: 'Résumé', icon: 'resume', url: `${import.meta.env.BASE_URL}Noah-Menendez-Resume.pdf` } and a 'resume' glyph in Lab.tsx
];
