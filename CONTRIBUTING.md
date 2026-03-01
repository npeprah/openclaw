# Contributing to OpenClaw Tools

This is a personal repository for OpenClaw tools and skills. However, if you'd like to use these as a starting point for your own OpenClaw setup, feel free to fork this repository!

## Creating Custom Skills

1. Create a new `.js` file in the `skills/` directory
2. Export a skill object with the following structure:

```javascript
export const skill = {
  name: 'your-skill-name',
  description: 'What your skill does',
  
  async execute(context) {
    // Your skill logic here
    return 'Response message';
  }
};

export default skill;
```

3. Test your skill with OpenClaw
4. Document your skill in the README

## Configuration Files

When adding configuration examples:
1. Place them in the `configs/` directory
2. Use `.example` suffix for template files
3. Document required fields and options
4. Never commit actual credentials or tokens

## Best Practices

- Keep skills focused on a single purpose
- Add proper error handling
- Document parameters and return values
- Test skills before committing
- Follow OpenClaw's security guidelines

## Resources

- [OpenClaw Documentation](https://docs.openclaw.ai)
- [Skills API Reference](https://docs.openclaw.ai/tools/skills)
- [Security Guidelines](https://docs.openclaw.ai/gateway/security)
