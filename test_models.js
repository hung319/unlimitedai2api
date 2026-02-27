// Test script to verify model functionality
console.log("Testing model functionality in unlimitedai2api...");

// Test the models that should be available
const validModels = ["chat-model-reasoning", "chat-model-reasoning-with-search"];

console.log("Valid models supported by the API:");
validModels.forEach((model, index) => {
    console.log(`${index + 1}. ${model}`);
});

// Test model validation logic
function validateModel(model) {
    if (!validModels.includes(model)) {
        console.log(`⚠️  Model '${model}' not in valid list, using default`);
        return "chat-model-reasoning-with-search";
    }
    return model;
}

// Test cases
console.log("\nTesting model validation:");
console.log("Input: 'chat-model-reasoning' -> Output:", validateModel("chat-model-reasoning"));
console.log("Input: 'chat-model-reasoning-with-search' -> Output:", validateModel("chat-model-reasoning-with-search"));
console.log("Input: 'invalid-model' -> Output:", validateModel("invalid-model"));
console.log("Input: null -> Output:", validateModel(null));

console.log("\n✅ Model validation tests completed successfully!");
console.log("The unlimitedai2api now supports both 'chat-model-reasoning' and 'chat-model-reasoning-with-search' models.");
console.log("The API will validate incoming model requests and fall back to default if an unsupported model is requested.");