/**
 * AsiaInfo's brand mark, as this plugin's own artwork.
 *
 * Taken from AsiaInfo's published single-colour logo
 * (`https://www.asiainfo.com/include/images/logo-white.svg`, the `单色黑logo`
 * group): the three paths that draw the emblem, kept on the ink box they
 * occupy, with the `AsiaInfo` wordmark and the `亚信科技` line dropped — the
 * brand row pairs the mark with THIS deployment's product name, so the vendor's
 * own lettering would only repeat the text beside it.
 *
 * Colour rides `currentColor`, exactly like the ui-primitives icons: a mark
 * that inherits the ink of the surface it lands on follows the theme instead of
 * pinning one theme's fill, which is also how the vendor ships this artwork
 * (its own group is named for the monochrome cut).
 */
import type { ReactNode } from 'react'

/** Ink box the three emblem paths draw inside the vendor's 114x36 canvas. */
const VIEW_BOX = '0.767 0.1 35.5 35.833'

/** Height / width of {@link VIEW_BOX} — near square, 0.9% taller than wide. */
const MARK_ASPECT = 35.833 / 35.5

/** Props of {@link AsiaInfoMark}: the same `size`/`className` pair every slot owner passes. */
export interface AsiaInfoMarkProps {
  /** Width in px (default 24); the height keeps {@link MARK_ASPECT}. */
  size?: number | undefined
  /** Extra class for layout placement. */
  className?: string | undefined
}

/**
 * Render the AsiaInfo mark.
 * @param props - see {@link AsiaInfoMarkProps}.
 * @returns the mark svg (aria-hidden: the brand name rendered beside it carries the text).
 */
export function AsiaInfoMark({ size = 24, className }: AsiaInfoMarkProps): ReactNode {
  return (
    <svg
      width={size}
      height={size * MARK_ASPECT}
      className={className}
      viewBox={VIEW_BOX}
      fill="none"
      aria-hidden="true"
      // Marks the artwork itself, so this plugin's stylesheet can address the
      // mark on hosts whose own class it does not own (the conversation hero).
      data-wui="brandMarkArt"
    >
      <g fill="currentColor" fillRule="nonzero">
        <path d="M30.5217155,23.7101734 C29.9818629,25.2370105 28.5489309,26.7598083 25.5677273,27.2647147 C22.7475184,27.7413464 19.8167758,28.0604473 11.4923136,27.4214377 C11.4923136,27.4214377 11.0613927,27.3560018 10.4222201,27.230785 C8.462251,26.9076449 4.12661028,25.881675 1.65642443,22.8683934 C1.52506565,22.7068234 1.4081243,22.5452533 1.29278488,22.3756047 C2.50143096,27.2687776 5.70303466,31.4194241 10.1083237,33.80431 C14.5136128,36.1891959 19.7127216,36.5864328 24.4239448,34.8980922 C27.5757545,33.30178 29.5637575,31.1197764 30.331886,28.4094386 C30.7892388,26.7888909 30.7572001,25.164304 30.5185116,23.7101734" />
        <path d="M33.8873837,9.10424007 C32.9090847,7.39435131 31.657093,5.8594533 30.182105,4.56169785 L30.182105,4.56977636 C27.0070671,2.55015062 23.9746016,1.91114103 21.170412,2.67455956 C19.6742035,3.07848471 18.403067,3.84594249 17.3618084,4.69822455 C18.9437205,4.40255135 20.9725729,4.89291648 22.8997023,7.25103149 C24.7187011,9.47261981 26.4584039,11.872743 30.0747752,19.465728 C30.0747752,19.465728 31.5461538,23.269895 31.5461538,25.3436467 C31.5461538,25.4325103 31.5637751,25.595696 31.5637751,25.595696 C31.5770707,26.6275754 31.4443758,27.6560929 31.1696987,28.650178 C30.7795398,30.0035579 30.1059814,31.2567387 29.1945112,32.325089 C36.3410362,26.8862159 38.3539254,16.9313164 33.8897866,9.10424007" />
        <path d="M18.1379465,3.06879051 C18.1435533,3.0639434 18.150762,3.05990415 18.1563688,3.0558649 C18.1916114,3.03647649 18.227655,3.01062529 18.2612956,2.99042903 C18.3237712,2.95488361 18.3846447,2.92499315 18.4463193,2.89025559 C19.2267906,2.43062765 20.0633887,2.07567794 20.9349274,1.83439525 C22.5368638,1.39654039 24.2060814,1.38765404 25.9185514,1.77946143 C23.5886339,0.698262235 21.055066,0.13616526 18.4903725,0.131446828 C9.1445098,0.144742605 1.40828752,7.46179896 0.795383646,16.8676814 L0.805796232,16.8676814 C0.789776868,17.0219808 0.792980741,17.1690096 0.785772027,17.3184619 C0.776961378,17.5220402 0.773757505,17.722387 0.7713546,17.9259653 L1.19586773,17.9259653 L0.769752664,17.9259653 L1.19586773,17.9259653 L0.769752664,17.9259653 L0.769752664,17.9259653 L0.769752664,17.9259653 L0.769752664,17.9300046 L0.769752664,17.9300046 C0.769752664,17.9712049 0.769752664,18.0107896 0.769752664,18.0495664 C0.819412691,19.665267 1.33443523,21.0935463 2.32282995,22.3004747 C3.68447585,23.9654541 5.73255147,24.9793063 7.54994825,25.5924646 C6.55434481,24.3516066 6.01289033,22.3659105 7.04694024,19.5764035 C8.04414562,16.8773756 9.23278239,14.1573437 13.9504849,7.20013692 C13.9504849,7.20013692 16.363802,4.16261981 18.1411504,3.0558649 L18.1379465,3.06879051 Z" />
      </g>
    </svg>
  )
}
