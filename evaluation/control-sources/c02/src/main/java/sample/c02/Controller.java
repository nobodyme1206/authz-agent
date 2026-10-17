package sample.c02;
import java.security.Principal;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/c02")
public class Controller {
    private Mapper mapper;
    @GetMapping("/records")
    public Object run(@RequestParam String id, @RequestParam String owner, Principal principal) {
        return mapper.fetch(id, owner);
    }
}
