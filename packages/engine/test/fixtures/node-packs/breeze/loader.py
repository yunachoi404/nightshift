import comfy.model_management as mm


def _unregister_from_comfy(patcher) -> None:
    patcher.detach()


class Loader:
    def load(self, to_load):
        mm.load_models_gpu(to_load)
        return to_load

    def unload(self, patchers, hard=False):
        for patcher in patchers:
            _unregister_from_comfy(patcher)
