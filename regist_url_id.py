MODEL_LIST = {}
from redis_hanlder import RedisManager

def init_model_list():
    try:
        redis_client = RedisManager.get_client()

        keys = redis_client.keys("*")

        for key in keys:
            model_name = key.split(":")[0]
            url_id = key.split(":")[1]
            is_on = key.split(":")[2]

            MODEL_LIST[model_name] = {
                "url_id": url_id,
                "is_on": is_on,
            }
    except Exception as e:
        raise Exception(f"Failed to initialize model list: {e}")


def regist_url_id(model_name: str, url_id: str, is_on: bool = True):
    global MODEL_LIST
    if MODEL_LIST.get(model_name, None) is None:
        MODEL_LIST[model_name] = {
            "url_id": url_id,
            "is_on": is_on,
        }

        redis_client = RedisManager.get_client()
        redis_client.set(f"{model_name}:{url_id}:{is_on}", True)

        return True

    if MODEL_LIST.get(model_name, None).get("url_id") != url_id:
        MODEL_LIST[model_name] = {
            "url_id": url_id,
            "is_on": is_on,
        }
        return True
    else:
        return False







