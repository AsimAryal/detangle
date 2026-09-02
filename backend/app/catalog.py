from typing import Any

from app.demucster import DemucsterClient, DemucsterError
from app.schemas import ModelInfo

CURATED_MODELS = {
    "htdemucs": ModelInfo(
        id="htdemucs",
        name="HTDemucs",
        description="Balanced four-stem separation for most music.",
        stems=["drums", "bass", "other", "vocals"],
        quality="high",
        speed="medium",
    ),
    "htdemucs_ft": ModelInfo(
        id="htdemucs_ft",
        name="HTDemucs Fine-tuned",
        description="Higher-quality four-stem model with slower processing.",
        stems=["drums", "bass", "other", "vocals"],
        is_default=True,
        quality="very high",
        speed="slow",
    ),
    "htdemucs_6s": ModelInfo(
        id="htdemucs_6s",
        name="HTDemucs 6 stems",
        description="Separates vocals, drums, bass, guitar, piano, and other.",
        stems=["drums", "bass", "other", "vocals", "guitar", "piano"],
        quality="high",
        speed="slow",
    ),
    "mdx_extra": ModelInfo(
        id="mdx_extra",
        name="MDX Extra",
        description="Alternative high-quality vocal and accompaniment separation.",
        stems=["drums", "bass", "other", "vocals"],
        quality="high",
        speed="medium",
    ),
    "mdx_extra_q": ModelInfo(
        id="mdx_extra_q",
        name="MDX Extra Quantized",
        description="Faster, smaller MDX model with a modest quality tradeoff.",
        stems=["drums", "bass", "other", "vocals"],
        quality="medium",
        speed="fast",
    ),
    "mdx": ModelInfo(
        id="mdx",
        name="MDX",
        description="Fast MDX baseline for efficient four-stem separation.",
        stems=["drums", "bass", "other", "vocals"],
        quality="medium",
        speed="fast",
    ),
}


def parse_live_model(item: dict[str, Any] | str) -> ModelInfo | None:
    if isinstance(item, str):
        model_id = item
        data: dict[str, Any] = {}
    else:
        raw_id = item.get("id", item.get("name", item.get("model")))
        if not isinstance(raw_id, str):
            return None
        model_id = raw_id
        data = item
    fallback = CURATED_MODELS.get(model_id)
    return ModelInfo(
        id=model_id,
        name=str(
            data.get(
                "display_name",
                fallback.name if fallback else model_id,
            )
        ),
        description=str(
            data.get(
                "description",
                fallback.description if fallback else "Audio source-separation model.",
            )
        ),
        stems=[
            str(stem)
            for stem in data.get("stems", fallback.stems if fallback else [])
            if isinstance(stem, str)
        ],
        is_default=bool(data.get("is_default", fallback.is_default if fallback else False)),
        quality=str(data.get("quality", fallback.quality if fallback else "")) or None,
        speed=str(data.get("speed", fallback.speed if fallback else "")) or None,
    )


async def available_models(
    demucster: DemucsterClient,
) -> tuple[list[ModelInfo], bool]:
    try:
        raw_models = await demucster.models()
    except DemucsterError:
        return list(CURATED_MODELS.values()), False
    models = [parsed for item in raw_models if (parsed := parse_live_model(item)) is not None]
    return (models or list(CURATED_MODELS.values())), bool(models)
