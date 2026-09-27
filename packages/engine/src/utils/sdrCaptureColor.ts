// Chrome captures arrive as BT.601 full-range JPEG or RGB PNG; a direct YUV->YUV scale keeps the
// BT.601 matrix (or tints greys on newer ffmpeg), so go through RGB into the BT.709 the output is tagged.
export const SDR_CAPTURE_TO_BT709_FILTER =
  "scale=in_color_matrix=bt601:in_range=pc,format=gbrp,scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd";
