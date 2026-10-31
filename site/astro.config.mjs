// The Flux documentation site: Astro Starlight, published on GitHub Pages at https://coldphase.github.io/flux/.
// Its pages are generated from the repository's docs by scripts/sync-docs.mjs (npm run build runs it first).
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';

export default defineConfig({
  site: 'https://coldphase.github.io',
  base: '/flux',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'Flux',
      description: 'An open source, self-hostable workspace where people and AI agents work on the same projects.',
      logo: {
        light: '../docs/assets/brand/kreska-light.svg',
        dark: '../docs/assets/brand/kreska-dark.svg',
        alt: 'Flux',
      },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/ColdPhase/flux' }],
      customCss: ['./src/styles/flux.css'],
      lastUpdated: false,
      pagination: true,
      plugins: [starlightLinksValidator({ errorOnLocalLinks: false })],
      sidebar: [
        {
          label: 'Start',
          items: [
            { label: 'Overview', link: '/' },
            { label: 'Quick start', link: '/start/quick-start/' },
            { label: 'Connect your own agent', link: '/start/connect-your-agent/' },
          ],
        },
        {
          label: 'Self-hosting',
          items: [
            { label: 'Overview', link: '/operate/' },
            { label: 'Requirements', link: '/operate/requirements/' },
            { label: 'Installation', link: '/operate/install/' },
            { label: 'HTTPS and reverse proxies', link: '/operate/reverse-proxy/' },
            { label: 'Configuration reference', link: '/operate/configuration/' },
            { label: 'Architecture', link: '/operate/architecture/' },
            {
              label: 'Operations',
              items: [
                { label: 'Upgrade', link: '/operate/upgrade/' },
                { label: 'Backup and restore', link: '/operate/backup-restore/' },
                { label: 'Project export', link: '/operate/export/' },
                { label: 'Encrypted spaces', link: '/operate/encrypted-spaces/' },
                { label: 'Health, monitoring and logs', link: '/operate/monitoring/' },
                { label: 'Capacity and scaling', link: '/operate/scaling/' },
                { label: 'Security hardening', link: '/operate/hardening/' },
                { label: 'Troubleshooting and FAQ', link: '/operate/troubleshooting/' },
              ],
            },
            {
              label: 'Features',
              items: [
                { label: 'Administration in the app', link: '/operate/administration/' },
                { label: 'Single sign-on', link: '/operate/single-sign-on/' },
                { label: 'Phones, tablets and push', link: '/operate/mobile-and-push/' },
                { label: 'Agent runtime', link: '/operate/agent-runtime/' },
              ],
            },
            {
              label: 'Releases',
              items: [
                { label: 'Install from a release', link: '/operate/install-release/' },
                { label: 'Release install guide', link: '/operate/release-guide/' },
              ],
            },
          ],
        },
        { label: 'Integrate', items: [{ label: 'Integrating with Flux', link: '/integrate/' }] },
        {
          label: 'Security',
          items: [
            { label: 'Encrypted spaces', link: '/security/encrypted-spaces/' },
            { label: 'Security policy', link: '/security/' },
          ],
        },
        {
          label: 'Contribute',
          items: [
            { label: 'Contributing', link: '/contribute/' },
            { label: 'Governance', link: '/contribute/governance/' },
            { label: 'Licensing', link: '/contribute/licensing/' },
            { label: 'Changelog', link: '/contribute/changelog/' },
          ],
        },
      ],
    }),
  ],
});
